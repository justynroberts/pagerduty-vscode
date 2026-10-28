// Sign-in. Credentials live in SecretStorage only: never in settings, globalState, logs or the webview.

import { createHash, randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { Credentials, Region, regionHosts } from './api';

const SECRET_KEY = 'pagerduty.credentials';
const TOKEN_HELP_URL = 'https://support.pagerduty.com/main/docs/api-access-keys#generate-a-user-token-rest-api-key';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

// A client ID baked in here gives every install one-click OAuth. Until the PagerDuty app is
// registered it stays empty and sign-in uses a user API token, unless pagerduty.oauthClientId is set.
const BUNDLED_CLIENT_ID = '';

const b64url = (buf: Buffer) => buf.toString('base64url');

export class AuthManager implements vscode.UriHandler {
  private pending?: { state: string; resolve: (code: string) => void; reject: (e: Error) => void };
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async get(): Promise<Credentials | undefined> {
    const raw = await this.ctx.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Credentials;
    } catch {
      return undefined;
    }
  }

  async store(c: Credentials | undefined): Promise<void> {
    if (c) await this.ctx.secrets.store(SECRET_KEY, JSON.stringify(c));
    else await this.ctx.secrets.delete(SECRET_KEY);
    this.changed.fire();
  }

  private region(): Region {
    return vscode.workspace.getConfiguration('pagerduty').get<Region>('region', 'us');
  }

  private clientId(): string {
    return vscode.workspace.getConfiguration('pagerduty').get<string>('oauthClientId', '').trim() || BUNDLED_CLIENT_ID;
  }

  // Returns credentials without storing them; the caller verifies them against /users/me first.
  async signIn(): Promise<Credentials | undefined> {
    const clientId = this.clientId();
    if (!clientId) return this.askForToken();
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(globe) Sign in with PagerDuty', detail: 'Opens your browser once, then returns to VS Code', method: 'oauth' as const },
        { label: '$(key) Use a user API token', detail: 'For accounts where OAuth apps are not enabled', method: 'token' as const },
      ],
      { title: 'Sign in to PagerDuty', ignoreFocusOut: true },
    );
    if (!pick) return undefined;
    return pick.method === 'oauth' ? this.oauth(clientId) : this.askForToken();
  }

  private askForToken(): Promise<Credentials | undefined> {
    return new Promise((resolve) => {
      const box = vscode.window.createInputBox();
      const help: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('question'), tooltip: 'How to create a user API token' };
      box.title = 'Sign in to PagerDuty';
      box.prompt = 'Paste a user API token. In PagerDuty: My Profile → User Settings → Create API User Token.';
      box.placeholder = 'User API token';
      box.password = true;
      box.ignoreFocusOut = true;
      box.buttons = [help];
      let done = false;
      box.onDidTriggerButton(() => void vscode.env.openExternal(vscode.Uri.parse(TOKEN_HELP_URL)));
      box.onDidChangeValue((v) => {
        box.validationMessage = /\s/.test(v.trim()) ? 'A token has no spaces.' : undefined;
      });
      box.onDidAccept(() => {
        const token = box.value.trim();
        if (!token || box.validationMessage) return;
        done = true;
        box.hide();
        resolve({ kind: 'token', accessToken: token });
      });
      box.onDidHide(() => {
        box.dispose();
        if (!done) resolve(undefined);
      });
      box.show();
    });
  }

  private async oauth(clientId: string): Promise<Credentials | undefined> {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));
    // asExternalUri makes the vscode:// callback work under Remote SSH, WSL and Codespaces.
    const callback = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://${this.ctx.extension.id}/auth`));
    const redirectUri = callback.toString(true);
    const { app } = regionHosts(this.region());

    const authorize = new URL('/oauth/authorize', app);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'write',
    }).toString();

    const code = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Waiting for PagerDuty sign-in in your browser…', cancellable: true },
      (_p, cancel) =>
        new Promise<string | undefined>((resolve, reject) => {
          const timer = setTimeout(() => finish(() => reject(new Error('Sign-in timed out.'))), SIGN_IN_TIMEOUT_MS);
          const finish = (fn: () => void) => {
            clearTimeout(timer);
            this.pending = undefined;
            fn();
          };
          this.pending = {
            state,
            resolve: (c) => finish(() => resolve(c)),
            reject: (e) => finish(() => reject(e)),
          };
          cancel.onCancellationRequested(() => finish(() => resolve(undefined)));
          void vscode.env.openExternal(vscode.Uri.parse(authorize.toString()));
        }),
    );
    if (!code) return undefined;

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    return { kind: 'oauth', clientId, ...tokens };
  }

  // Called by the API client on a 401. A failed refresh returns undefined and the caller signs out.
  async refresh(c: Credentials): Promise<Credentials | undefined> {
    if (c.kind !== 'oauth' || !c.refreshToken || !c.clientId) return undefined;
    try {
      const tokens = await this.tokenRequest({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refreshToken });
      const next: Credentials = { ...c, ...tokens, refreshToken: tokens.refreshToken ?? c.refreshToken };
      await this.ctx.secrets.store(SECRET_KEY, JSON.stringify(next));
      return next;
    } catch (e) {
      this.log.warn(`Token refresh failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<Pick<Credentials, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
    const { app } = regionHosts(this.region());
    const res = await fetch(new URL('/oauth/token', app), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new Error(`PagerDuty token exchange failed (${res.status}${body.error ? `: ${String(body.error)}` : ''}).`);
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresAt: typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : undefined,
    };
  }

  handleUri(uri: vscode.Uri): void {
    if (uri.path !== '/auth') return;
    const params = new URLSearchParams(uri.query);
    if (!this.pending || params.get('state') !== this.pending.state) {
      this.log.warn('Ignored a sign-in redirect with an unknown state.');
      return;
    }
    const error = params.get('error');
    const code = params.get('code');
    if (error || !code) this.pending.reject(new Error(params.get('error_description') ?? error ?? 'No authorization code returned.'));
    else this.pending.resolve(code);
  }
}

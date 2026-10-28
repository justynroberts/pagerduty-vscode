// Client for the optional push relay (relay/server.mjs). While the stream is live, each event
// triggers an immediate sync and polling relaxes to the slow interval as a safety net.

import * as vscode from 'vscode';
import { isSafeRelayUrl } from './model';
import { Store } from './store';

const TOKEN_KEY = 'pagerduty.relayToken';

export type RelayState = 'off' | 'connecting' | 'live' | 'error';

export class RelayClient implements vscode.Disposable {
  state: RelayState = 'off';
  lastError?: string;
  private abort?: AbortController;
  private retryTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private backoff = 1000;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  private url(): string {
    return vscode.workspace.getConfiguration('pagerduty').get<string>('relayUrl', '').trim().replace(/\/+$/, '');
  }

  async configure(url: string, token: string): Promise<void> {
    await this.ctx.secrets.store(TOKEN_KEY, token);
    await vscode.workspace.getConfiguration('pagerduty').update('relayUrl', url, vscode.ConfigurationTarget.Global);
    await this.restart();
  }

  async clear(): Promise<void> {
    await this.ctx.secrets.delete(TOKEN_KEY);
    await vscode.workspace.getConfiguration('pagerduty').update('relayUrl', undefined, vscode.ConfigurationTarget.Global);
    this.stop();
  }

  async restart(): Promise<void> {
    this.stop();
    const url = this.url();
    const token = await this.ctx.secrets.get(TOKEN_KEY);
    if (!url || !token || !this.store.signedIn) return;
    if (!isSafeRelayUrl(url)) {
      this.setState('error', 'pagerduty.relayUrl must use https (http only for localhost). Not connecting.');
      this.log.error(this.lastError!);
      return;
    }
    this.backoff = 1000;
    void this.connect(url, token);
  }

  stop(): void {
    this.abort?.abort();
    clearTimeout(this.retryTimer);
    this.setState('off');
  }

  private setState(s: RelayState, error?: string): void {
    this.state = s;
    this.lastError = error;
    this.store.setLive(s === 'live');
    this.changed.fire();
  }

  private async connect(url: string, token: string): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.setState('connecting');
    try {
      const res = await fetch(`${url}/events`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: abort.signal });
      if (res.status === 401) throw new Error('The relay rejected the token.');
      if (!res.ok || !res.body) throw new Error(`Relay returned ${res.status}`);
      this.setState('live');
      this.backoff = 1000;
      this.log.info(`Push relay connected: ${url}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (data) this.onEvent(data);
        }
      }
      throw new Error('Relay closed the stream.');
    } catch (e) {
      if (abort.signal.aborted) return;
      const msg = (e as Error).message;
      this.log.warn(`Push relay: ${msg}. Retrying in ${this.backoff / 1000}s; polling meanwhile.`);
      this.setState('error', msg);
      this.retryTimer = setTimeout(() => void this.connect(url, token), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    }
  }

  private onEvent(data: string): void {
    let evt: { type?: string; incidentId?: string | null };
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    this.log.debug(`Relay event ${evt.type} ${evt.incidentId ?? ''}`);
    // Bursts (an incident storm) collapse into one sync.
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      void this.store.sync().then(() => {
        if (evt.incidentId && this.store.isWatched(evt.incidentId)) void this.store.loadDetail(evt.incidentId);
      });
    }, 500);
  }

  dispose(): void {
    this.stop();
    clearTimeout(this.syncTimer);
    this.changed.dispose();
  }
}

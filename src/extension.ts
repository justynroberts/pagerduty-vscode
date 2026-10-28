// Entry point: wires auth, the API client, the store and every surface together.

import * as vscode from 'vscode';
import { PagerDutyClient, PdError, Region, resolveApiBase } from './api';
import { AuditLog } from './audit';
import { AuthManager } from './auth';
import { CodeContext } from './codeContext';
import { watchMapping } from './mapping';
import { registerChat } from './chat';
import { registerMcp } from './mcp';
import { DEFAULT_FILTER, Filter, Incident, IncidentStatus, Mapping, Me, STATUS_LABEL, Scope, canWrite, isFiltered, selectIncidents } from './model';
import { PanelManager } from './panel';
import { RelayClient } from './relay';
import { registerRespondCommands } from './respond';
import { Store } from './store';
import { IncidentItem, IncidentTree, OnCallTree, StatusBar } from './views';

const MAX_NOTIFICATIONS_PER_POLL = 3;

export async function activate(ctx: vscode.ExtensionContext): Promise<TestingApi | undefined> {
  const log = vscode.window.createOutputChannel('PagerDuty', { log: true });
  const cfg = () => vscode.workspace.getConfiguration('pagerduty');
  const auth = new AuthManager(ctx, log);
  const audit = new AuditLog(ctx.globalStorageUri);
  // `store` is assigned below; fromEmail is only read once requests start.
  let store: Store;
  const api = new PagerDutyClient({
    apiBase: () => resolveApiBase(cfg().get<Region>('region', 'us'), cfg().get<string>('apiBaseUrl', '')),
    credentials: () => auth.get(),
    refresh: (c) => auth.refresh(c),
    fromEmail: () => store?.me?.email,
    log: (m) => log.debug(m),
  });
  let mapping: Mapping | undefined;
  store = new Store(ctx, api, audit, log, new CodeContext(() => mapping?.paths));

  const access = (): { canWrite: boolean; reason?: string } => {
    if (!vscode.workspace.isTrusted) return { canWrite: false, reason: 'Read-only in an untrusted workspace.' };
    if (!canWrite(store.me)) return { canWrite: false, reason: 'Your PagerDuty role is read-only.' };
    return { canWrite: true };
  };

  const scopes: Scope[] = ['mine', 'teams', 'all'];
  const trees = scopes.map((scope) => {
    const tree = new IncidentTree(store, scope);
    const view = vscode.window.createTreeView(`pagerduty.${scope}`, { treeDataProvider: tree, canSelectMany: true });
    return { scope, tree, view };
  });
  const onCallTree = new OnCallTree(store);
  const onCallView = vscode.window.createTreeView('pagerduty.oncall', { treeDataProvider: onCallTree });
  const statusBar = new StatusBar(store);
  const panels = new PanelManager(ctx, store, access);
  const relay = new RelayClient(ctx, store, log);

  const render = () => {
    const filtered = isFiltered(store.filter);
    for (const { scope, tree, view } of trees) {
      tree.refresh();
      view.message = tree.emptyMessage();
      view.description = filtered ? (store.filter.text ? `“${store.filter.text}”` : 'filtered') : undefined;
      if (scope === 'mine') {
        const triggered = tree.items().filter((i) => i.status === 'triggered').length;
        view.badge = triggered ? { value: triggered, tooltip: `${triggered} triggered incident${triggered === 1 ? '' : 's'} assigned to you` } : undefined;
      }
    }
    onCallTree.refresh();
    onCallView.message = store.signedIn && store.oncalls.length === 0 ? 'No on-call data yet.' : undefined;
    statusBar.update();
    panels.pushAll();
    void vscode.commands.executeCommand('setContext', 'pagerduty.signedIn', store.signedIn);
    void vscode.commands.executeCommand('setContext', 'pagerduty.canWrite', store.signedIn && access().canWrite);
    void vscode.commands.executeCommand('setContext', 'pagerduty.filtered', filtered);
  };

  ctx.subscriptions.push(
    log,
    store,
    statusBar,
    panels,
    relay,
    relay.onDidChange(render),
    onCallView,
    ...trees.map((t) => t.view),
    vscode.window.registerUriHandler(auth),
    store.onDidChange(render),
    watchMapping((m) => {
      mapping = m;
      store.setServiceId(m?.serviceId);
    }, log),
    vscode.workspace.onDidGrantWorkspaceTrust(render),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pagerduty.theme')) panels.pushAll();
      if (e.affectsConfiguration('pagerduty.region') || e.affectsConfiguration('pagerduty.apiBaseUrl')) void signOut('Region changed. Sign in again for the new region.');
      if (e.affectsConfiguration('pagerduty.pollIntervalSeconds')) void store.sync();
      if (e.affectsConfiguration('pagerduty.relayUrl')) void relay.restart();
    }),
  );

  async function startSession(): Promise<boolean> {
    let me: Me;
    try {
      me = await api.me();
    } catch (e) {
      if (e instanceof PdError && e.status === 401) {
        await signOut('PagerDuty rejected the saved credentials. Sign in again.');
        return false;
      }
      // Offline at startup: keep the cached list and let polling retry.
      log.warn(`Couldn't verify sign-in: ${(e as Error).message}`);
      if (!store.me) {
        void vscode.window.showErrorMessage(`Couldn't reach PagerDuty: ${(e as Error).message}`);
        return false;
      }
      me = store.me;
    }
    store.start(me);
    log.info(`Signed in as ${me.name} (${me.role})`);
    void relay.restart();
    return true;
  }

  async function signOut(message?: string): Promise<void> {
    await auth.store(undefined);
    relay.stop();
    await store.stop(true);
    panels.closeAll();
    if (message) {
      const pick = await vscode.window.showWarningMessage(message, 'Sign In');
      if (pick) await vscode.commands.executeCommand('pagerduty.signIn');
    }
  }

  ctx.subscriptions.push(store.onUnauthorized(() => void signOut('Your PagerDuty session has expired. Sign in again.')));

  ctx.subscriptions.push(
    store.onNewAssigned((list) => {
      if (!cfg().get<boolean>('notifications', true)) return;
      for (const i of list.slice(0, MAX_NOTIFICATIONS_PER_POLL)) void notify(i);
      const rest = list.length - MAX_NOTIFICATIONS_PER_POLL;
      if (rest > 0) {
        void vscode.window.showWarningMessage(`PagerDuty: ${rest} more new incident${rest === 1 ? '' : 's'} assigned to you.`, 'Show').then((p) => {
          if (p) void vscode.commands.executeCommand('pagerduty.mine.focus');
        });
      }
    }),
  );

  async function notify(i: Incident): Promise<void> {
    const actions = access().canWrite ? ['Acknowledge', 'Open'] : ['Open'];
    const pick = await vscode.window.showWarningMessage(`PagerDuty #${i.number}: ${i.title} (${i.service.name})`, ...actions);
    if (pick === 'Acknowledge') await setStatus([i.id], 'acknowledged');
    if (pick === 'Open') panels.open(i.id);
  }

  // Commands accept a tree item, an incident id, or nothing (then the active pane, then a picker).
  function idsFrom(arg: unknown, selected: unknown): string[] {
    const one = (a: unknown) => (typeof a === 'string' ? a : a instanceof IncidentItem ? a.incident.id : undefined);
    if (Array.isArray(selected) && selected.length > 1) return selected.map(one).filter((x): x is string => !!x);
    const id = one(arg);
    return id ? [id] : [];
  }

  async function pickIncidents(statuses: IncidentStatus[], placeHolder: string, many: boolean): Promise<string[]> {
    const filter: Filter = { ...DEFAULT_FILTER, statuses };
    const mine = new Set(selectIncidents(store.incidents.values(), 'mine', store.me, filter).map((i) => i.id));
    const all = selectIncidents(store.incidents.values(), 'all', store.me, filter).sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)));
    if (!all.length) {
      void vscode.window.showInformationMessage('No matching incidents.');
      return [];
    }
    const items = all.map((i) => ({
      label: `#${i.number} ${i.title}`,
      description: `${STATUS_LABEL[i.status]} · ${i.service.name}${mine.has(i.id) ? ' · yours' : ''}`,
      id: i.id,
    }));
    if (many) {
      const picks = await vscode.window.showQuickPick(items, { placeHolder, canPickMany: true, matchOnDescription: true });
      return picks?.map((p) => p.id) ?? [];
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
    return pick ? [pick.id] : [];
  }

  async function resolveTargets(arg: unknown, selected: unknown, statuses: IncidentStatus[], verb: string): Promise<string[]> {
    const ids = idsFrom(arg, selected);
    if (ids.length) return ids;
    const active = panels.activeId;
    if (active) return [active];
    return pickIncidents(statuses, `Select incidents to ${verb}`, true);
  }

  async function setStatus(ids: string[], status: IncidentStatus): Promise<void> {
    const failures = await store.setStatus(ids, status);
    const verb = status === 'acknowledged' ? 'acknowledge' : 'resolve';
    for (const f of failures.slice(0, 3)) {
      void vscode.window.showErrorMessage(`Couldn't ${verb} #${f.incident.number}: ${f.error.message}`);
    }
    const ok = ids.length - failures.length;
    if (ok > 0 && status === 'resolved') {
      vscode.window.setStatusBarMessage(`$(check-all) Resolved ${ok} incident${ok === 1 ? '' : 's'}`, 4000);
    }
  }

  const command = (id: string, fn: (...args: unknown[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  registerRespondCommands({
    ctx,
    store,
    api,
    canWrite: access,
    target: async (arg, selected, statuses, verb) => {
      const ids = idsFrom(arg, selected);
      const id = ids[0] ?? panels.activeId ?? (await pickIncidents(statuses, `Select an incident to ${verb}`, false))[0];
      if (!id) return undefined;
      return store.get(id) ?? api.incident(id).catch(() => undefined);
    },
  });

  registerChat(ctx, store, panels, () => store.signedIn && access().canWrite);

  const mcp = registerMcp(() => auth.get(), auth.onDidChange, log);
  if (mcp) ctx.subscriptions.push(mcp);

  command('pagerduty.signIn', async () => {
    let creds;
    try {
      creds = await auth.signIn();
    } catch (e) {
      void vscode.window.showErrorMessage(`PagerDuty sign-in failed: ${(e as Error).message}`);
      return;
    }
    if (!creds) return;
    await auth.store(creds);
    let me: Me;
    try {
      me = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Signing in to PagerDuty' }, () => api.me());
    } catch (e) {
      await auth.store(undefined);
      void vscode.window.showErrorMessage(`PagerDuty sign-in failed: ${(e as Error).message}`);
      return;
    }
    store.start(me);
    void relay.restart();
    void vscode.window.showInformationMessage(`Signed in to PagerDuty as ${me.name}.`);
    void vscode.commands.executeCommand('pagerduty.mine.focus');
  });

  command('pagerduty.signOut', () => signOut());
  command('pagerduty.refresh', () => store.sync());

  command('pagerduty.openIncident', async (arg, selected) => {
    const ids = idsFrom(arg, selected);
    const targets = ids.length ? ids : await pickIncidents(['triggered', 'acknowledged'], 'Open an incident', false);
    targets.forEach((id) => panels.open(id));
  });

  command('pagerduty.acknowledge', async (arg, selected) => {
    if (!access().canWrite) return void vscode.window.showWarningMessage(access().reason ?? 'Read only.');
    const ids = (await resolveTargets(arg, selected, ['triggered'], 'acknowledge')).filter((id) => store.get(id)?.status === 'triggered');
    if (ids.length) await setStatus(ids, 'acknowledged');
  });

  command('pagerduty.resolve', async (arg, selected) => {
    if (!access().canWrite) return void vscode.window.showWarningMessage(access().reason ?? 'Read only.');
    const ids = (await resolveTargets(arg, selected, ['triggered', 'acknowledged'], 'resolve')).filter((id) => {
      const s = store.get(id)?.status;
      return s === 'triggered' || s === 'acknowledged';
    });
    if (!ids.length) return;
    const incidents = ids.map((id) => store.get(id)!);
    const what = incidents.length === 1 ? `#${incidents[0].number} ${incidents[0].title}` : `${incidents.length} incidents`;
    const detail =
      (incidents.length > 1 ? incidents.map((i) => `#${i.number} ${i.title}`).join('\n') + '\n\n' : '') +
      'This resolves it in PagerDuty for everyone on the incident, and assignees stop being notified.';
    const ok = await vscode.window.showWarningMessage(`Resolve ${what}?`, { modal: true, detail }, 'Resolve');
    if (ok === 'Resolve') await setStatus(ids, 'resolved');
  });

  command('pagerduty.openInBrowser', async (arg, selected) => {
    const ids = idsFrom(arg, selected);
    const targets = ids.length ? ids : panels.activeId ? [panels.activeId] : await pickIncidents(['triggered', 'acknowledged'], 'Open in PagerDuty', false);
    for (const id of targets) {
      const url = store.get(id)?.htmlUrl;
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  });

  command('pagerduty.filter', async () => {
    const f = store.filter;
    type Item = vscode.QuickPickItem & { apply?: (f: Filter) => void };
    const statusItem = (s: IncidentStatus, label: string): Item => ({
      label,
      picked: (f.statuses.length ? f.statuses : ['triggered', 'acknowledged']).includes(s),
      apply: (n) => n.statuses.push(s),
    });
    const urgencyItem = (u: 'high' | 'low'): Item => ({ label: `${u === 'high' ? 'High' : 'Low'} urgency`, picked: f.urgencies.includes(u), apply: (n) => n.urgencies.push(u) });
    const services = new Map<string, string>();
    for (const i of store.incidents.values()) services.set(i.service.id, i.service.name);
    const items: Item[] = [
      { label: 'Status', kind: vscode.QuickPickItemKind.Separator },
      statusItem('triggered', 'Triggered'),
      statusItem('acknowledged', 'Acknowledged'),
      statusItem('resolved', 'Resolved in the last 24h'),
      { label: 'Urgency (none selected shows all)', kind: vscode.QuickPickItemKind.Separator },
      urgencyItem('high'),
      urgencyItem('low'),
      { label: 'Service (none selected shows all)', kind: vscode.QuickPickItemKind.Separator },
      ...[...services]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, name]): Item => ({ label: name, picked: f.serviceIds.includes(id), apply: (n) => n.serviceIds.push(id) })),
    ];
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Filter incidents' });
    if (!picks) return;
    const next: Filter = { statuses: [], urgencies: [], serviceIds: [], text: f.text };
    picks.forEach((p) => p.apply?.(next));
    await store.setFilter(next);
  });

  command('pagerduty.clearFilter', () => store.setFilter(DEFAULT_FILTER));

  command('pagerduty.search', async () => {
    const text = await vscode.window.showInputBox({
      title: 'Search incidents',
      prompt: 'Matches incident number, title, service and assignee',
      value: store.filter.text,
    });
    if (text !== undefined) await store.setFilter({ ...store.filter, text });
  });

  command('pagerduty.showAuditLog', () => audit.show());

  command('pagerduty.connectRelay', async () => {
    const url = await vscode.window.showInputBox({
      title: 'Connect push relay (1/2)',
      prompt: 'Relay URL, e.g. https://pd-relay.example.com. See relay/README.md to run one.',
      value: cfg().get<string>('relayUrl', ''),
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          const u = new URL(v.trim());
          const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
          return u.protocol === 'https:' || (u.protocol === 'http:' && loopback) ? undefined : 'Use https (http only for localhost).';
        } catch {
          return 'Enter a full URL.';
        }
      },
    });
    if (!url) return;
    const token = await vscode.window.showInputBox({ title: 'Connect push relay (2/2)', prompt: 'The relay’s RELAY_TOKEN', password: true, ignoreFocusOut: true });
    if (!token) return;
    await relay.configure(url.trim(), token.trim());
  });

  command('pagerduty.disconnectRelay', () => relay.clear());

  command('pagerduty.about', async () => {
    const pick = await vscode.window.showInformationMessage(
      `PagerDuty Incidents ${ctx.extension.packageJSON.version}`,
      { modal: true, detail: 'Made by FintonLabs.' },
      'Visit fintonlabs.com',
    );
    if (pick) await vscode.env.openExternal(vscode.Uri.parse('https://fintonlabs.com'));
  });

  render();
  if (await auth.get()) {
    store.restoreCache();
    await startSession();
  }

  // Only the extension test host gets handles into the internals.
  if (ctx.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    store,
    panels,
    relay,
    async signInWithToken(token: string) {
      await auth.store({ kind: 'token', accessToken: token });
      return startSession();
    },
  };
}

export interface TestingApi {
  store: Store;
  panels: PanelManager;
  relay: RelayClient;
  signInWithToken(token: string): Promise<boolean>;
}

export function deactivate(): void {}

// The incident pane: one webview editor tab per incident, so it can sit beside code.

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { openCommit, openFile } from './codeContext';
import { HostMessage, PANE_ACTIONS, PaneMessage, PaneState, PaneTheme, RenderReport } from './protocol';
import { Store } from './store';

const TRUSTED_LINK_HOST = /(^|\.)pagerduty\.com$/i;

export class PanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly ready = new Set<string>();
  readonly renderReports = new Map<string, RenderReport>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly access: () => { canWrite: boolean; reason?: string },
  ) {}

  get activeId(): string | undefined {
    for (const [id, p] of this.panels) if (p.active) return id;
    return undefined;
  }

  open(id: string): void {
    const existing = this.panels.get(id);
    if (existing) {
      existing.reveal(undefined, false);
      return;
    }
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel('pagerduty.incident', this.title(id), vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'pane.svg');
    panel.webview.html = this.html(panel.webview, dist);
    this.panels.set(id, panel);
    this.store.watch(id);

    panel.webview.onDidReceiveMessage((m: PaneMessage) => void this.onMessage(id, m));
    // The pane keeps no state of its own, so a hidden pane re-renders from the host when shown.
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.post(id);
    });
    panel.onDidDispose(() => {
      this.panels.delete(id);
      this.ready.delete(id);
      this.store.unwatch(id);
    });
    void this.store.loadDetail(id).then(() => this.store.loadInsights(id));
  }

  pushAll(): void {
    for (const id of this.panels.keys()) this.post(id);
  }

  closeAll(): void {
    for (const p of [...this.panels.values()]) p.dispose();
  }

  private title(id: string): string {
    const i = this.store.get(id);
    if (!i) return 'Incident';
    const t = i.title.length > 32 ? `${i.title.slice(0, 31)}…` : i.title;
    return `#${i.number} ${t}`;
  }

  private state(id: string): PaneState {
    const access = this.access();
    return {
      incident: this.store.get(id),
      detail: this.store.details.get(id),
      insights: this.store.insights.get(id),
      loading: this.store.loadingDetail.has(id),
      insightsLoading: this.store.loadingInsights.has(id),
      isMine: !!this.store.me && !!this.store.get(id)?.assignees.some((a) => a.id === this.store.me!.id),
      error: this.store.detailErrors.get(id),
      pending: this.store.pending.has(id),
      canWrite: access.canWrite,
      readOnlyReason: access.reason,
      theme: vscode.workspace.getConfiguration('pagerduty').get<PaneTheme>('theme', 'auto'),
      version: String(this.ctx.extension.packageJSON.version),
      now: new Date().toISOString(),
      diagnostics: this.ctx.extensionMode === vscode.ExtensionMode.Test,
    };
  }

  private post(id: string): void {
    const panel = this.panels.get(id);
    if (!panel || !this.ready.has(id) || !panel.visible) return;
    panel.title = this.title(id);
    const msg: HostMessage = { type: 'state', state: this.state(id) };
    void panel.webview.postMessage(msg);
  }

  private async onMessage(id: string, m: PaneMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready.add(id);
        this.post(id);
        return;
      case 'rendered':
        this.renderReports.set(id, m.report);
        return;
      case 'action':
        if (!(PANE_ACTIONS as readonly string[]).includes(m.action)) return;
        await vscode.commands.executeCommand(`pagerduty.${m.action}`, id, undefined, m.workflowId);
        return;
      case 'addNote':
        await vscode.commands.executeCommand('pagerduty.addNote', id, undefined, m.content);
        return;
      case 'refresh':
        await this.store.loadDetail(id);
        await this.store.loadInsights(id);
        return;
      case 'openFile':
        await openFile(m.path, m.line);
        return;
      case 'openCommit':
        await openCommit(m.hash, m.repoRoot);
        return;
      case 'openIncident':
        this.open(m.id);
        return;
      case 'openLink':
        await openUntrustedLink(m.url);
        return;
    }
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'main.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'main.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<!-- MIT License - Copyright (c) fintonlabs.com -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>PagerDuty incident</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.closeAll();
  }
}

// Links inside incident content can point anywhere. Only https opens, and non-PagerDuty hosts ask first.
export async function openUntrustedLink(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== 'https:') {
    void vscode.window.showWarningMessage(`Blocked a ${url.protocol} link from incident content.`);
    return;
  }
  if (!TRUSTED_LINK_HOST.test(url.hostname)) {
    const ok = await vscode.window.showWarningMessage(
      `Open ${url.hostname}?`,
      { modal: true, detail: `This link came from incident content:\n${url.toString()}` },
      'Open',
    );
    if (ok !== 'Open') return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
}

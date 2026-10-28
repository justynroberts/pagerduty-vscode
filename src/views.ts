// Native surfaces: the incident and on-call tree views and the status bar item.

import * as vscode from 'vscode';
import { Incident, OnCall, Scope, STATUS_LABEL, formatAge, isFiltered, selectIncidents } from './model';
import { Store } from './store';

// State is carried by shape as well as colour: filled dot, open eye, tick.
const STATUS_ICON: Record<Incident['status'], vscode.ThemeIcon> = {
  triggered: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('errorForeground')),
  acknowledged: new vscode.ThemeIcon('eye', new vscode.ThemeColor('editorWarning.foreground')),
  resolved: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
};

export class IncidentItem extends vscode.TreeItem {
  constructor(readonly incident: Incident, pending: boolean) {
    super(`#${incident.number} ${incident.title}`, vscode.TreeItemCollapsibleState.None);
    const urgency = incident.urgency === 'low' ? ' · low' : '';
    this.description = `${incident.service.name} · ${formatAge(incident.createdAt)}${urgency}${pending ? ' · updating…' : ''}`;
    this.iconPath = pending ? new vscode.ThemeIcon('sync~spin') : STATUS_ICON[incident.status];
    this.contextValue = `incident.${incident.status}`;
    this.id = incident.id;
    this.accessibilityInformation = {
      label: `${STATUS_LABEL[incident.status]}, ${incident.urgency} urgency, incident ${incident.number}: ${incident.title}, ${incident.service.name}`,
    };
    this.command = { command: 'pagerduty.openIncident', title: 'Open Incident', arguments: [incident.id] };

    // Incident text is untrusted: appendText escapes it, and the string is never marked trusted.
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown('**').appendText(`#${incident.number} ${incident.title}`).appendMarkdown('**\n\n');
    tip.appendText(`${STATUS_LABEL[incident.status]} · ${incident.urgency} urgency${incident.priority ? ` · ${incident.priority}` : ''}\n`);
    tip.appendText(`Service: ${incident.service.name}\n`);
    tip.appendText(`Assigned: ${incident.assignees.map((a) => a.name).join(', ') || 'nobody'}\n`);
    tip.appendText(`Opened ${new Date(incident.createdAt).toLocaleString()}`);
    this.tooltip = tip;
  }
}

export class IncidentTree implements vscode.TreeDataProvider<IncidentItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: Store,
    private readonly scope: Scope,
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  items(): Incident[] {
    return selectIncidents(this.store.incidents.values(), this.scope, this.store.me, this.store.filter);
  }

  getTreeItem(e: IncidentItem): vscode.TreeItem {
    return e;
  }

  getChildren(): IncidentItem[] {
    if (!this.store.me) return [];
    return this.items().map((i) => new IncidentItem(i, this.store.pending.has(i.id)));
  }

  // Lets the view answer reveal() for keyboard-driven selection.
  getParent(): undefined {
    return undefined;
  }

  emptyMessage(): string | undefined {
    const s = this.store;
    if (!s.me) return undefined;
    if (s.error) return `Couldn't reach PagerDuty: ${s.error}`;
    if (this.items().length) return undefined;
    if (this.scope === 'teams' && s.me.teams.length === 0) return "You aren't on any PagerDuty team.";
    if (!s.lastSync && s.incidents.size === 0) return 'Loading incidents…';
    return isFiltered(s.filter) ? 'No incidents match the filter.' : 'No open incidents. All quiet.';
  }
}

class OnCallItem extends vscode.TreeItem {
  constructor(o: OnCall, isMe: boolean) {
    super(o.policy.name, vscode.TreeItemCollapsibleState.None);
    this.description = isMe ? `${o.user.name} (you)` : o.user.name;
    this.tooltip = `${o.policy.name}\nLevel ${o.level}: ${o.user.name}${o.schedule ? `\nSchedule: ${o.schedule}` : ''}`;
    this.iconPath = new vscode.ThemeIcon(isMe ? 'account' : 'person');
  }
}

export class OnCallTree implements vscode.TreeDataProvider<OnCallItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: Store) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(e: OnCallItem): vscode.TreeItem {
    return e;
  }

  getChildren(): OnCallItem[] {
    const meId = this.store.me?.id;
    return [...this.store.oncalls]
      .sort((a, b) => (a.user.id === meId ? -1 : 0) - (b.user.id === meId ? -1 : 0) || a.policy.name.localeCompare(b.policy.name))
      .map((o) => new OnCallItem(o, o.user.id === meId));
  }
}

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('pagerduty.status', vscode.StatusBarAlignment.Left, 50);

  constructor(private readonly store: Store) {
    this.item.name = 'PagerDuty';
    this.item.command = 'pagerduty.mine.focus';
  }

  update(): void {
    const s = this.store;
    if (!s.signedIn || !s.me) {
      this.item.text = '$(bell-slash) PagerDuty';
      this.item.tooltip = 'Sign in to PagerDuty';
      this.item.command = 'pagerduty.signIn';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    this.item.command = 'pagerduty.mine.focus';
    const mine = selectIncidents(s.incidents.values(), 'mine', s.me, { statuses: ['triggered', 'acknowledged'], urgencies: [], serviceIds: [], text: '' });
    const triggered = mine.filter((i) => i.status === 'triggered').length;
    const oncall = s.serviceOnCall?.names.length ? ` $(person) ${s.serviceOnCall.names.join(', ')}` : '';
    this.item.text = `${triggered ? '$(bell-dot)' : '$(bell)'} ${mine.length}${oncall}${s.live ? ' $(broadcast)' : ''}`;
    this.item.backgroundColor = triggered ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;

    const tip = new vscode.MarkdownString();
    tip.appendText(`PagerDuty: ${mine.length} open incident${mine.length === 1 ? '' : 's'} assigned to you (${triggered} triggered)\n\n`);
    const worst = mine[0];
    if (worst) tip.appendText(`Worst: #${worst.number} ${worst.title} (${STATUS_LABEL[worst.status]}, ${worst.urgency})\n\n`);
    if (s.serviceOnCall) tip.appendText(`On call for this repo's service: ${s.serviceOnCall.names.join(', ') || 'nobody'}\n\n`);
    if (s.live) tip.appendText('Live updates through the push relay.\n\n');
    if (s.error) tip.appendText(`Last sync failed: ${s.error}`);
    else if (s.lastSync) tip.appendText(`Synced ${s.lastSync.toLocaleTimeString()}`);
    this.item.tooltip = tip;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

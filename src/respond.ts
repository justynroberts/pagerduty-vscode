// Response commands beyond acknowledge and resolve: escalate, reassign, urgency, priority, snooze,
// notes, responders, merge, status updates, incident workflows, Paige and the editor agent.
// Anything that affects other people asks once and shows exactly what changes.

import * as vscode from 'vscode';
import { PagerDutyClient, PdError } from './api';
import { FOLLOW_UP_PREFIX, incidentSummary, Incident, IncidentStatus, isPaigeWorkflow, selectIncidents, DEFAULT_FILTER, STATUS_LABEL } from './model';
import { Store } from './store';

const PAIGE_SETUP_URL = 'https://docs.pagerduty.com/ai-automation/advance/add-paige-as-virtual-responder';

export interface RespondDeps {
  ctx: vscode.ExtensionContext;
  store: Store;
  api: PagerDutyClient;
  canWrite: () => { canWrite: boolean; reason?: string };
  // Resolves a command argument (tree item, id, active pane) to one incident, or asks.
  target: (arg: unknown, selected: unknown, statuses: IncidentStatus[], verb: string) => Promise<Incident | undefined>;
}

const label = (i: Incident) => `#${i.number} ${i.title}`;

async function confirm(i: Incident, action: string, detail: string, button: string): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(`${action} ${label(i)}?`, { modal: true, detail }, button);
  return pick === button;
}

function report(error: PdError | undefined, verb: string, i: Incident, success?: string): void {
  if (error) void vscode.window.showErrorMessage(`Couldn't ${verb} #${i.number}: ${error.message}`);
  else if (success) vscode.window.setStatusBarMessage(`$(check) ${success}`, 4000);
}

// A QuickPick that searches PagerDuty users as you type.
function pickUsers(api: PagerDutyClient, title: string, many: boolean): Promise<{ id: string; name: string }[] | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
    qp.title = title;
    qp.placeholder = 'Type a name or email';
    qp.canSelectMany = many;
    qp.matchOnDescription = true;
    let timer: NodeJS.Timeout | undefined;
    let seq = 0;
    const kept = new Map<string, vscode.QuickPickItem & { id: string }>();
    const search = (q: string) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++seq;
        qp.busy = true;
        try {
          const users = await api.searchUsers(q);
          if (mine !== seq) return;
          // Keep earlier selections visible so a multi-select survives a new search.
          qp.selectedItems.forEach((s) => kept.set(s.id, s));
          const items = users.filter((u) => !kept.has(u.id)).map((u) => ({ label: u.name, description: u.email, id: u.id }));
          qp.items = [...kept.values(), ...items];
          qp.selectedItems = [...kept.values()];
        } catch (e) {
          qp.placeholder = `Search failed: ${(e as Error).message}`;
        } finally {
          if (mine === seq) qp.busy = false;
        }
      }, 250);
    };
    let done = false;
    qp.onDidChangeValue(search);
    qp.onDidAccept(() => {
      const picks = many ? qp.selectedItems : qp.activeItems.slice(0, 1);
      if (!picks.length) return;
      done = true;
      resolve(picks.map((p) => ({ id: p.id, name: p.label })));
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!done) resolve(undefined);
    });
    search('');
    qp.show();
  });
}

export function registerRespondCommands(d: RespondDeps): void {
  const { ctx, store, api } = d;
  const open: IncidentStatus[] = ['triggered', 'acknowledged'];

  const command = (id: string, fn: (...args: unknown[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const writable = (): boolean => {
    const a = d.canWrite();
    if (!a.canWrite) void vscode.window.showWarningMessage(a.reason ?? 'Read only.');
    return a.canWrite;
  };

  command('pagerduty.escalate', async (arg, selected) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, open, 'escalate');
    if (!i) return;
    let levels: { level: number; targets: string }[];
    try {
      levels = await api.escalationLevels(i.escalationPolicy.id);
    } catch (e) {
      return void vscode.window.showErrorMessage(`Couldn't read the escalation policy: ${(e as Error).message}`);
    }
    if (!levels.length) return void vscode.window.showInformationMessage(`${i.escalationPolicy.name} has no levels to escalate to.`);
    const pick = await vscode.window.showQuickPick(
      levels.map((l) => ({ label: `Level ${l.level}`, description: l.targets || 'no targets', level: l.level })),
      { title: `Escalate ${label(i)}`, placeHolder: `${i.escalationPolicy.name}: choose the level to notify` },
    );
    if (!pick) return;
    if (!(await confirm(i, 'Escalate', `Escalates to ${pick.label} of ${i.escalationPolicy.name} and notifies ${pick.description}.`, 'Escalate'))) return;
    report(await store.mutate(i.id, `escalate:level-${pick.level}`, () => api.updateIncident(i.id, { escalation_level: pick.level })), 'escalate', i, `Escalated #${i.number} to ${pick.label}`);
  });

  command('pagerduty.reassign', async (arg, selected) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, open, 'reassign');
    if (!i) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: '$(person) A user', value: 'user' as const },
        { label: '$(organization) An escalation policy', value: 'policy' as const },
      ],
      { title: `Reassign ${label(i)}`, placeHolder: `Currently: ${i.assignees.map((a) => a.name).join(', ') || 'nobody'}` },
    );
    if (!kind) return;
    if (kind.value === 'user') {
      const users = await pickUsers(api, `Reassign ${label(i)} to`, false);
      const u = users?.[0];
      if (!u) return;
      if (!(await confirm(i, 'Reassign', `Assigns it to ${u.name} instead of ${i.assignees.map((a) => a.name).join(', ') || 'nobody'}. ${u.name} is notified.`, 'Reassign'))) return;
      report(
        await store.mutate(i.id, `reassign:user:${u.id}`, () => api.updateIncident(i.id, { assignments: [{ assignee: { id: u.id, type: 'user_reference' } }] })),
        'reassign',
        i,
        `Reassigned #${i.number} to ${u.name}`,
      );
    } else {
      const q = await vscode.window.showInputBox({ title: 'Find an escalation policy', prompt: 'Part of the policy name' });
      if (q === undefined) return;
      const policies = await api.searchEscalationPolicies(q).catch((e: Error) => (void vscode.window.showErrorMessage(e.message), []));
      const p = await vscode.window.showQuickPick(policies.map((x) => ({ label: x.name, id: x.id })), { title: 'Reassign to escalation policy' });
      if (!p) return;
      if (!(await confirm(i, 'Reassign', `Moves it from ${i.escalationPolicy.name} to ${p.label}, which starts notifying from level 1.`, 'Reassign'))) return;
      report(
        await store.mutate(i.id, `reassign:policy:${p.id}`, () => api.updateIncident(i.id, { escalation_policy: { id: p.id, type: 'escalation_policy_reference' } })),
        'reassign',
        i,
        `Reassigned #${i.number} to ${p.label}`,
      );
    }
  });

  command('pagerduty.changeUrgency', async (arg, selected) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, open, 'change urgency of');
    if (!i) return;
    const next = i.urgency === 'high' ? 'low' : 'high';
    const detail = next === 'high' ? 'High urgency pages responders with their high-urgency rules.' : 'Low urgency stops high-urgency paging for this incident.';
    if (!(await confirm(i, `Change to ${next} urgency:`, detail, `Make ${next}`))) return;
    report(await store.mutate(i.id, `urgency:${next}`, () => api.updateIncident(i.id, { urgency: next })), 'change urgency of', i, `#${i.number} is now ${next} urgency`);
  });

  command('pagerduty.changePriority', async (arg, selected) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, open, 'set priority on');
    if (!i) return;
    let priorities;
    try {
      priorities = await api.priorities();
    } catch (e) {
      return void vscode.window.showErrorMessage(`Couldn't load priorities: ${(e as Error).message}`);
    }
    if (!priorities.length) return void vscode.window.showInformationMessage('Priorities are not enabled on this PagerDuty account.');
    const pick = await vscode.window.showQuickPick(
      [...priorities.map((p) => ({ label: p.name, description: p.description, id: p.id as string | null })), { label: 'No priority', description: '', id: null }],
      { title: `Priority for ${label(i)}`, placeHolder: `Currently: ${i.priority ?? 'none'}` },
    );
    if (!pick) return;
    if (!(await confirm(i, 'Set priority on', `Changes priority from ${i.priority ?? 'none'} to ${pick.label}.`, 'Set priority'))) return;
    const priority = pick.id ? { id: pick.id, type: 'priority_reference' } : null;
    report(await store.mutate(i.id, `priority:${pick.label}`, () => api.updateIncident(i.id, { priority })), 'set priority on', i, `#${i.number} priority set to ${pick.label}`);
  });

  command('pagerduty.snooze', async (arg, selected) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, ['acknowledged'], 'snooze');
    if (!i) return;
    if (i.status !== 'acknowledged') return void vscode.window.showInformationMessage('Only acknowledged incidents can be snoozed. Acknowledge it first.');
    const pick = await vscode.window.showQuickPick(
      [
        ['30 minutes', 1800],
        ['1 hour', 3600],
        ['2 hours', 7200],
        ['4 hours', 14400],
        ['8 hours', 28800],
        ['24 hours', 86400],
      ].map(([l, s]) => ({ label: l as string, seconds: s as number })),
      { title: `Snooze ${label(i)}` },
    );
    if (!pick) return;
    if (!(await confirm(i, 'Snooze', `It returns to triggered in ${pick.label} and notifies the assignees again.`, 'Snooze'))) return;
    report(await store.mutate(i.id, `snooze:${pick.seconds}s`, () => api.snooze(i.id, pick.seconds)), 'snooze', i, `Snoozed #${i.number} for ${pick.label}`);
  });

  command('pagerduty.addNote', async (arg, selected, text) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, ['triggered', 'acknowledged', 'resolved'], 'add a note to');
    if (!i) return;
    const content =
      typeof text === 'string' && text.trim()
        ? text.trim()
        : await vscode.window.showInputBox({ title: `Note on ${label(i)}`, prompt: 'Visible to everyone on the incident', ignoreFocusOut: true });
    if (!content) return;
    report(await store.mutate(i.id, 'note', () => api.addNote(i.id, content)), 'add a note to', i, `Note added to #${i.number}`);
  });

  command('pagerduty.addFollowUp', async (arg, selected, text) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, ['triggered', 'acknowledged', 'resolved'], 'add a follow-up to');
    if (!i) return;
    const content =
      typeof text === 'string' && text.trim()
        ? text.trim()
        : await vscode.window.showInputBox({ title: `Follow-up for ${label(i)}`, prompt: 'Saved on the incident as a note starting “Follow-up:”', ignoreFocusOut: true });
    if (!content) return;
    report(await store.mutate(i.id, 'follow_up', () => api.addNote(i.id, `${FOLLOW_UP_PREFIX} ${content}`)), 'add a follow-up to', i, `Follow-up added to #${i.number}`);
  });

  command('pagerduty.addResponders', async (arg, selected) => {
    if (!writable()) return;
    const me = store.me;
    const i = await d.target(arg, selected, open, 'add responders to');
    if (!i || !me) return;
    const users = await pickUsers(api, `Add responders to ${label(i)}`, true);
    if (!users?.length) return;
    const message = await vscode.window.showInputBox({
      title: 'Message for the responders',
      value: `Please help with ${label(i)}`,
      ignoreFocusOut: true,
    });
    if (!message) return;
    const names = users.map((u) => u.name).join(', ');
    if (!(await confirm(i, 'Add responders to', `Pages ${names} with their high-urgency rules until they accept or decline.\n\n“${message}”`, 'Request'))) return;
    report(
      await store.mutate(i.id, `responders:${users.map((u) => u.id).join(',')}`, () => api.requestResponders(i.id, me.id, message, users.map((u) => ({ id: u.id, type: 'user' as const })))),
      'add responders to',
      i,
      `Requested ${names}`,
    );
  });

  command('pagerduty.merge', async (arg, selected) => {
    if (!writable()) return;
    const target = await d.target(arg, selected, open, 'merge into');
    if (!target) return;
    const candidates = selectIncidents(store.incidents.values(), 'all', store.me, DEFAULT_FILTER).filter((x) => x.id !== target.id);
    if (!candidates.length) return void vscode.window.showInformationMessage('There are no other open incidents to merge.');
    const sameService = (x: Incident) => x.service.id === target.service.id;
    const picks = await vscode.window.showQuickPick(
      candidates
        .sort((a, b) => Number(sameService(b)) - Number(sameService(a)))
        .map((x) => ({ label: label(x), description: `${STATUS_LABEL[x.status]} · ${x.service.name}${sameService(x) ? ' · same service' : ''}`, id: x.id })),
      { title: `Merge into ${label(target)}`, placeHolder: 'Pick the incidents to merge in', canPickMany: true },
    );
    if (!picks?.length) return;
    const preview =
      `Into: ${label(target)}\n\nMerging:\n${picks.map((p) => `  ${p.label}`).join('\n')}\n\n` +
      'Their alerts move to the target incident and they are resolved. This cannot be undone.';
    if (!(await confirm(target, 'Merge into', preview, 'Merge'))) return;
    report(
      await store.mutate(target.id, `merge:${picks.map((p) => p.id).join(',')}`, () => api.merge(target.id, picks.map((p) => p.id))),
      'merge into',
      target,
      `Merged ${picks.length} into #${target.number}`,
    );
    void store.sync();
  });

  command('pagerduty.statusUpdate', async (arg, selected) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, open, 'post a status update on');
    if (!i) return;
    const message = await vscode.window.showInputBox({
      title: `Status update for ${label(i)}`,
      prompt: 'Sent to the incident’s subscribers and stakeholders',
      ignoreFocusOut: true,
    });
    if (!message) return;
    if (!(await confirm(i, 'Send status update on', `Subscribers receive:\n\n“${message}”`, 'Send'))) return;
    report(await store.mutate(i.id, 'status_update', () => api.statusUpdate(i.id, message)), 'post a status update on', i, `Status update sent for #${i.number}`);
  });

  async function runWorkflow(i: Incident, workflowId: string, name: string, detail: string): Promise<boolean> {
    if (!(await confirm(i, `Run “${name}” on`, detail, 'Run'))) return false;
    const err = await store.mutate(i.id, `workflow:${workflowId}`, () => api.startWorkflow(workflowId, i.id));
    report(err, `run ${name} on`, i);
    if (!err) void store.loadInsights(i.id);
    return !err;
  }

  command('pagerduty.runWorkflow', async (arg, selected, workflowId) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, ['triggered', 'acknowledged', 'resolved'], 'run a workflow on');
    if (!i) return;
    let triggers;
    try {
      triggers = await api.manualWorkflows(i.id);
    } catch (e) {
      return void vscode.window.showErrorMessage(`Couldn't list incident workflows: ${(e as Error).message}`);
    }
    let chosen = typeof workflowId === 'string' ? triggers.find((t) => t.workflowId === workflowId) : undefined;
    if (!chosen) {
      if (!triggers.length) return void vscode.window.showInformationMessage(`No manually triggered workflows are set up for ${i.service.name}.`);
      const pick = await vscode.window.showQuickPick(
        triggers.map((t) => ({ label: isPaigeWorkflow(t) ? `$(sparkle) ${t.workflowName}` : t.workflowName, t })),
        { title: `Run an incident workflow on ${label(i)}` },
      );
      chosen = pick?.t;
    }
    if (!chosen) return;
    if (await runWorkflow(i, chosen.workflowId, chosen.workflowName, 'Runs the workflow’s actions in PagerDuty. Its steps may notify people or change the incident.')) {
      vscode.window.setStatusBarMessage(`$(play) Started ${chosen.workflowName}`, 4000);
    }
  });

  // Paige is reached through its "Paige virtual responder" incident workflow (manual trigger).
  // Its findings land in PagerDuty (and Slack when configured); notes it writes show in the pane.
  command('pagerduty.askPaige', async (arg, selected) => {
    if (!writable()) return;
    const i = await d.target(arg, selected, ['triggered', 'acknowledged', 'resolved'], 'ask Paige about');
    if (!i) return;
    let paige;
    try {
      paige = (await api.manualWorkflows(i.id)).filter(isPaigeWorkflow);
    } catch (e) {
      return void vscode.window.showErrorMessage(`Couldn't reach incident workflows: ${(e as Error).message}`);
    }
    if (!paige.length) {
      const pick = await vscode.window.showInformationMessage(
        `Paige isn't set up for ${i.service.name}. Add the “Paige virtual responder” incident workflow with a manual trigger, then try again. Meanwhile you can ask your editor's agent, which has PagerDuty tools.`,
        'How to set up Paige',
        'Ask editor agent',
      );
      if (pick === 'How to set up Paige') await vscode.env.openExternal(vscode.Uri.parse(PAIGE_SETUP_URL));
      if (pick === 'Ask editor agent') await vscode.commands.executeCommand('pagerduty.askAgent', i.id);
      return;
    }
    const wf =
      paige.length === 1
        ? paige[0]
        : (await vscode.window.showQuickPick(paige.map((t) => ({ label: t.workflowName, t })), { title: 'Which Paige workflow?' }))?.t;
    if (!wf) return;
    const ok = await runWorkflow(
      i,
      wf.workflowId,
      wf.workflowName,
      'Adds Paige as a virtual responder. Paige investigates and posts findings, likely causes and next steps to the incident. Uses AI credits.',
    );
    if (ok) {
      void vscode.window.showInformationMessage(`Paige is investigating #${i.number}. Notes it adds appear in the pane as they land.`);
      // Poll the detail a few times so Paige's first notes show without a manual refresh.
      for (const delay of [20_000, 45_000, 90_000]) setTimeout(() => void store.loadDetail(i.id), delay);
    }
  });

  command('pagerduty.copySummary', async (arg, selected) => {
    const i = await d.target(arg, selected, ['triggered', 'acknowledged', 'resolved'], 'copy');
    if (!i) return;
    await vscode.env.clipboard.writeText(incidentSummary(store.get(i.id) ?? i, store.details.get(i.id)));
    vscode.window.setStatusBarMessage(`$(copy) Copied #${i.number} summary`, 3000);
  });

  // One keyboard entry point to every action on an incident.
  command('pagerduty.incidentActions', async (arg, selected) => {
    const i = await d.target(arg, selected, ['triggered', 'acknowledged', 'resolved'], 'act on');
    if (!i) return;
    const w = d.canWrite().canWrite;
    const isOpen = i.status !== 'resolved';
    const items: (vscode.QuickPickItem & { cmd?: string })[] = [
      { label: 'Respond', kind: vscode.QuickPickItemKind.Separator },
      ...(w && i.status === 'triggered' ? [{ label: '$(check) Acknowledge', cmd: 'pagerduty.acknowledge' }] : []),
      ...(w && isOpen ? [{ label: '$(check-all) Resolve', cmd: 'pagerduty.resolve' }] : []),
      ...(w && isOpen ? [{ label: '$(person) Reassign', cmd: 'pagerduty.reassign' }] : []),
      ...(w && isOpen ? [{ label: '$(arrow-up) Escalate', cmd: 'pagerduty.escalate' }] : []),
      ...(w && isOpen ? [{ label: '$(person-add) Add responders', cmd: 'pagerduty.addResponders' }] : []),
      ...(w && i.status === 'acknowledged' ? [{ label: '$(clock) Snooze', cmd: 'pagerduty.snooze' }] : []),
      ...(w ? [{ label: '$(note) Add note', cmd: 'pagerduty.addNote' }] : []),
      ...(w && isOpen ? [{ label: '$(megaphone) Post status update', cmd: 'pagerduty.statusUpdate' }] : []),
      { label: 'Learn', kind: vscode.QuickPickItemKind.Separator },
      ...(w ? [{ label: '$(checklist) Add follow-up', cmd: 'pagerduty.addFollowUp' }] : []),
      { label: 'Change', kind: vscode.QuickPickItemKind.Separator },
      ...(w && isOpen ? [{ label: `$(flame) Make ${i.urgency === 'high' ? 'low' : 'high'} urgency`, cmd: 'pagerduty.changeUrgency' }] : []),
      ...(w && isOpen ? [{ label: '$(list-ordered) Change priority', cmd: 'pagerduty.changePriority' }] : []),
      ...(w && isOpen ? [{ label: '$(git-merge) Merge other incidents into this one', cmd: 'pagerduty.merge' }] : []),
      ...(w ? [{ label: '$(play) Run incident workflow', cmd: 'pagerduty.runWorkflow' }] : []),
      { label: 'Investigate', kind: vscode.QuickPickItemKind.Separator },
      ...(w ? [{ label: '$(sparkle) Ask Paige to investigate', cmd: 'pagerduty.askPaige' }] : []),
      { label: '$(copilot) Ask editor agent', cmd: 'pagerduty.askAgent' },
      { label: '$(go-to-file) Open incident pane', cmd: 'pagerduty.openIncident' },
      { label: '$(copy) Copy summary', cmd: 'pagerduty.copySummary' },
      { label: '$(link-external) Open in PagerDuty', cmd: 'pagerduty.openInBrowser' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: label(i), placeHolder: `${STATUS_LABEL[i.status]} · ${i.service.name}` });
    if (pick?.cmd) await vscode.commands.executeCommand(pick.cmd, i.id);
  });

  // Hands the incident to the editor's agent chat, which reaches PagerDuty through the registered MCP server.
  command('pagerduty.askAgent', async (arg, selected) => {
    const i = await d.target(arg, selected, ['triggered', 'acknowledged', 'resolved'], 'ask the agent about');
    if (!i) return;
    const query =
      `Using the PagerDuty tools, investigate PagerDuty incident #${i.number} (ID ${i.id}, service “${i.service.name}”): ` +
      `summarise the timeline and alerts, check related change events and past incidents, look at the code in this workspace ` +
      `for likely causes, and suggest next steps. Don't change the incident without asking me first.`;
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent' });
    } catch {
      await vscode.env.clipboard.writeText(query);
      void vscode.window.showInformationMessage('No chat panel found in this editor. The prompt is on your clipboard for any agent you use.');
    }
  });
}

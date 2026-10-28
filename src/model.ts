// Normalised PagerDuty models and the pure logic around them.
// Nothing here imports vscode, so it is shared with the webview and unit tests.

export type IncidentStatus = 'triggered' | 'acknowledged' | 'resolved';
export type Urgency = 'high' | 'low';
export type Scope = 'mine' | 'teams' | 'all';

export interface Ref {
  id: string;
  name: string;
}

export interface Incident {
  id: string;
  number: number;
  title: string;
  status: IncidentStatus;
  urgency: Urgency;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  service: Ref;
  escalationPolicy: Ref;
  assignees: Ref[];
  acknowledgers: (Ref & { at: string })[];
  teams: Ref[];
  priority?: string;
}

export interface LogEntry {
  id: string;
  kind: string;
  summary: string;
  createdAt: string;
  agent?: string;
}

export interface Alert {
  id: string;
  summary: string;
  status: string;
  severity?: string;
  createdAt: string;
  htmlUrl?: string;
  details?: string;
}

export interface Note {
  id: string;
  content: string;
  createdAt: string;
  author: string;
}

export interface IncidentDetail {
  log: LogEntry[];
  alerts: Alert[];
  notes: Note[];
  fetchedAt: string;
}

export interface OnCall {
  user: Ref;
  policy: Ref;
  level: number;
  schedule?: string;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  role: string;
  teams: Ref[];
}

export interface Filter {
  statuses: IncidentStatus[];
  urgencies: Urgency[];
  serviceIds: string[];
  text: string;
}

export const OPEN_STATUSES: IncidentStatus[] = ['triggered', 'acknowledged'];
export const DEFAULT_FILTER: Filter = { statuses: OPEN_STATUSES, urgencies: [], serviceIds: [], text: '' };

// Roles that can see incidents but not change them.
const READ_ONLY_ROLES = new Set(['observer', 'read_only_user', 'read_only_limited_user', 'restricted_access']);

export function canWrite(me: Me | undefined): boolean {
  return !!me && !READ_ONLY_ROLES.has(me.role);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

const ref = (r: Raw): Ref => ({ id: r?.id ?? '', name: r?.summary ?? r?.name ?? '' });

export function normaliseIncident(r: Raw): Incident {
  return {
    id: r.id,
    number: r.incident_number,
    title: r.title ?? r.summary ?? '',
    status: r.status,
    urgency: r.urgency === 'low' ? 'low' : 'high',
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.last_status_change_at ?? r.created_at,
    htmlUrl: r.html_url ?? '',
    service: ref(r.service),
    escalationPolicy: ref(r.escalation_policy),
    assignees: (r.assignments ?? []).map((a: Raw) => ref(a.assignee)),
    acknowledgers: (r.acknowledgements ?? []).map((a: Raw) => ({ ...ref(a.acknowledger), at: a.at })),
    teams: (r.teams ?? []).map(ref),
    priority: r.priority?.summary ?? undefined,
  };
}

export function normaliseLogEntry(r: Raw): LogEntry {
  return {
    id: r.id,
    kind: String(r.type ?? '').replace(/_log_entry(_reference)?$/, ''),
    summary: r.summary ?? '',
    createdAt: r.created_at,
    agent: r.agent?.summary,
  };
}

export function normaliseAlert(r: Raw): Alert {
  const details = r.body?.details;
  return {
    id: r.id,
    summary: r.summary ?? '',
    status: r.status ?? '',
    severity: r.severity,
    createdAt: r.created_at,
    htmlUrl: r.html_url,
    details: details === undefined || details === null ? undefined : typeof details === 'string' ? details : JSON.stringify(details, null, 2),
  };
}

export function normaliseNote(r: Raw): Note {
  return { id: r.id, content: r.content ?? '', createdAt: r.created_at, author: r.user?.summary ?? 'Unknown' };
}

export function normaliseOnCall(r: Raw): OnCall {
  return { user: ref(r.user), policy: ref(r.escalation_policy), level: r.escalation_level, schedule: r.schedule?.summary };
}

export function normaliseMe(r: Raw): Me {
  return { id: r.id, name: r.name ?? r.summary ?? '', email: r.email ?? '', role: r.role ?? 'user', teams: (r.teams ?? []).map(ref) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const STATUS_RANK: Record<IncidentStatus, number> = { triggered: 0, acknowledged: 1, resolved: 2 };

// Triggered before acknowledged before resolved, high urgency first, newest first.
export function compareIncidents(a: Incident, b: Incident): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    (a.urgency === b.urgency ? 0 : a.urgency === 'high' ? -1 : 1) ||
    b.createdAt.localeCompare(a.createdAt)
  );
}

export function inScope(i: Incident, scope: Scope, me: Me | undefined): boolean {
  if (scope === 'all') return true;
  if (!me) return false;
  if (scope === 'mine') return i.assignees.some((a) => a.id === me.id);
  const teamIds = new Set(me.teams.map((t) => t.id));
  return i.teams.some((t) => teamIds.has(t.id));
}

export function matchesFilter(i: Incident, f: Filter): boolean {
  const statuses = f.statuses.length ? f.statuses : OPEN_STATUSES;
  if (!statuses.includes(i.status)) return false;
  if (f.urgencies.length && !f.urgencies.includes(i.urgency)) return false;
  if (f.serviceIds.length && !f.serviceIds.includes(i.service.id)) return false;
  const q = f.text.trim().toLowerCase();
  if (q) {
    const hay = `#${i.number} ${i.title} ${i.service.name} ${i.assignees.map((a) => a.name).join(' ')}`.toLowerCase();
    if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

export function selectIncidents(all: Iterable<Incident>, scope: Scope, me: Me | undefined, f: Filter): Incident[] {
  return [...all].filter((i) => inScope(i, scope, me) && matchesFilter(i, f)).sort(compareIncidents);
}

export function isFiltered(f: Filter): boolean {
  const defaultStatuses = f.statuses.length === 0 || (f.statuses.length === 2 && OPEN_STATUSES.every((s) => f.statuses.includes(s)));
  return !defaultStatuses || f.urgencies.length > 0 || f.serviceIds.length > 0 || f.text.trim() !== '';
}

export function formatAge(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  triggered: 'Triggered',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
};

export interface Mapping {
  serviceId: string;
  paths?: string[];
}

// Validates .pagerduty.json: serviceId drives the status bar, paths scope commits and likely files.
export function parseMapping(text: string): { mapping?: Mapping; error?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: `.pagerduty.json is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { error: '.pagerduty.json must be a JSON object, e.g. { "serviceId": "PXXXXXX" }' };
  }
  const serviceId = (data as Record<string, unknown>).serviceId;
  if (typeof serviceId !== 'string' || !/^P[A-Z0-9]{5,}$/.test(serviceId)) {
    return { error: '.pagerduty.json needs a "serviceId" like "PXXXXXX" (the ID at the end of the service URL in PagerDuty).' };
  }
  const paths = (data as Record<string, unknown>).paths;
  if (paths !== undefined && (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string'))) {
    return { error: '.pagerduty.json "paths" must be an array of glob strings, e.g. ["services/payments/**"]' };
  }
  return { mapping: { serviceId, paths: paths as string[] | undefined } };
}

// ---- Response, code context and AI insights (Phases 2-4) ----

export interface ChangeEvent {
  id: string;
  summary: string;
  timestamp: string;
  source?: string;
  reason?: string;
  links: { href: string; text: string }[];
}

export interface RelatedIncident {
  id: string;
  number?: number;
  title: string;
  status?: string;
  createdAt?: string;
  htmlUrl?: string;
  score?: number;
}

export interface WorkflowTrigger {
  triggerId: string;
  workflowId: string;
  workflowName: string;
}

export interface Commit {
  hash: string;
  message: string;
  author: string;
  date: string;
  repoRoot: string;
}

export interface LikelyFile {
  path: string;
  label: string;
  line?: number;
  reason: string;
}

// One slot per insight source. `unavailable` holds a readable reason (plan, permission, not set up).
export interface Slot<T> {
  items: T[];
  unavailable?: string;
}

export interface Insights {
  changes: Slot<ChangeEvent>;
  commits: Slot<Commit>;
  likelyFiles: Slot<LikelyFile>;
  past: Slot<RelatedIncident>;
  related: Slot<RelatedIncident>;
  outlier?: RelatedIncident;
  paige: Slot<WorkflowTrigger>;
  fetchedAt: string;
}

export interface Priority {
  id: string;
  name: string;
  description?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normaliseChangeEvent(r: Raw): ChangeEvent {
  return {
    id: r.id,
    summary: r.summary ?? '',
    timestamp: r.timestamp,
    source: r.source ?? r.integration?.summary ?? undefined,
    reason: r.correlation_reason?.reason,
    links: (r.links ?? []).filter((l: Raw) => typeof l?.href === 'string').map((l: Raw) => ({ href: l.href, text: l.text || l.href })),
  };
}

export function normaliseRelated(r: Raw, score?: number): RelatedIncident {
  return {
    id: r.id,
    number: r.incident_number,
    title: r.title ?? r.summary ?? '',
    status: r.status,
    createdAt: r.created_at,
    htmlUrl: r.html_url,
    score,
  };
}

export function normaliseTrigger(r: Raw): WorkflowTrigger {
  return { triggerId: r.id, workflowId: r.workflow?.id ?? r.workflow_id, workflowName: r.workflow?.name ?? r.workflow_name ?? 'Workflow' };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const isPaigeWorkflow = (t: WorkflowTrigger) => /paige|sre agent/i.test(t.workflowName);

// How Paige shows up as a note author or log-entry agent. Checked against real data with
// `npm run check:account`; adjust here if your account names it differently.
export const PAIGE_AUTHOR = /paige|pagerduty (ai|advance)|sre agent/i;

const CODE_EXT = 'ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|cs|php|scala|swift|c|cc|cpp|h|hpp|ex|exs|clj|lua|sql|yaml|yml|tf';
const PATH_RE = new RegExp(
  String.raw`(?:^|[\s"'(\[=@])(\/?(?:[\w.@-]+\/)*[\w.@-]+\.(?:${CODE_EXT}))\b(?::(\d+)|"?,\s*line\s+(\d+)|\((\d+)\))?`,
  'gi',
);

// Finds file paths (with optional line numbers) in stack traces and alert payloads.
export function extractPaths(text: string, max = 25): { path: string; line?: number }[] {
  const seen = new Map<string, { path: string; line?: number }>();
  for (const m of text.matchAll(PATH_RE)) {
    let path = m[1].replace(/^(\.\/)+/, '');
    if (/^(https?|www)\b/i.test(path) || path.includes('node_modules/') || path.includes('site-packages/')) continue;
    path = path.replace(/^\/+/, '');
    const line = m[2] ?? m[3] ?? m[4];
    if (!seen.has(path)) seen.set(path, { path, line: line ? Number(line) : undefined });
    if (seen.size >= max) break;
  }
  return [...seen.values()];
}

// ---- Postmortem (R17) ----

// Follow-ups are incident notes with this prefix, so they live in PagerDuty with the incident.
export const FOLLOW_UP_PREFIX = 'Follow-up:';
export const isFollowUp = (n: Note) => n.content.trimStart().toLowerCase().startsWith(FOLLOW_UP_PREFIX.toLowerCase());
export const followUpText = (n: Note) => n.content.trimStart().slice(FOLLOW_UP_PREFIX.length).trim();

function duration(fromIso: string, toIso: string): string {
  const mins = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// A Markdown postmortem draft assembled from everything the extension knows about the incident.
export function buildPostmortem(i: Incident, d: IncidentDetail | undefined, ins: Insights | undefined, now = new Date()): string {
  const log = [...(d?.log ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const resolvedAt = log.find((l) => l.kind === 'resolve')?.createdAt;
  const ackAt = log.find((l) => l.kind === 'acknowledge')?.createdAt;
  const notes = [...(d?.notes ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const followUps = notes.filter(isFollowUp);
  const discussion = notes.filter((n) => !isFollowUp(n));
  const t = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const lines: string[] = [
    `# Postmortem: #${i.number} ${i.title}`,
    '',
    `> Draft generated ${t(now.toISOString())} from PagerDuty incident ${i.htmlUrl || i.id}. Edit before sharing.`,
    '',
    '## Summary',
    '',
    '_What happened, in two or three sentences._',
    '',
    '## Impact',
    '',
    `- **Service:** ${i.service.name}`,
    `- **Urgency / priority:** ${i.urgency}${i.priority ? ` / ${i.priority}` : ''}`,
    `- **Triggered:** ${t(i.createdAt)}`,
    `- **Time to acknowledge:** ${ackAt ? duration(i.createdAt, ackAt) : 'not acknowledged'}`,
    `- **Time to resolve:** ${resolvedAt ? duration(i.createdAt, resolvedAt) : `still ${i.status}`}`,
    `- **Responders:** ${[...new Set([...i.assignees, ...i.acknowledgers].map((r) => r.name))].join(', ') || 'none recorded'}`,
    '',
    '## Timeline',
    '',
    ...(log.length ? log.map((l) => `- \`${t(l.createdAt)}\` ${l.summary}${l.agent ? ` (${l.agent})` : ''}`) : ['_No timeline loaded._']),
    '',
    '## Changes before the incident',
    '',
    ...(ins?.changes.items.length ? ins.changes.items.map((c) => `- \`${t(c.timestamp)}\` ${c.summary}${c.source ? ` (${c.source})` : ''}`) : []),
    ...(ins?.commits.items.length ? ins.commits.items.map((c) => `- \`${t(c.date)}\` commit \`${c.hash.slice(0, 7)}\` ${c.message} (${c.author})`) : []),
    ...(!ins?.changes.items.length && !ins?.commits.items.length ? ['_None found._'] : []),
    '',
    '## Root cause',
    '',
    '_Why it happened. Likely files flagged during the incident:_',
    '',
    ...(ins?.likelyFiles.items.length ? ins.likelyFiles.items.map((f) => `- \`${f.label}${f.line ? `:${f.line}` : ''}\` (${f.reason})`) : ['- _none_']),
    '',
    '## Discussion notes',
    '',
    ...(discussion.length ? discussion.map((n) => `- **${n.author}** \`${t(n.createdAt)}\`: ${n.content.replace(/\n+/g, ' ')}`) : ['_No notes._']),
    '',
    '## Similar incidents',
    '',
    ...(ins?.past.items.length ? ins.past.items.map((p) => `- #${p.number ?? '?'} ${p.title}`) : ['_None found._']),
    '',
    '## Follow-ups',
    '',
    ...(followUps.length ? followUps.map((n) => `- [ ] ${followUpText(n)} (${n.author})`) : ['- [ ] _Add follow-ups from the incident pane._']),
    '',
  ];
  return lines.join('\n');
}

// ---- Chat / voice intents (R19) ----

export type ChatIntent = 'mine' | 'ack' | 'resolve' | 'note' | 'paige' | 'ask';

// Maps a slash command or a natural (often dictated) sentence to an intent.
// "acknowledge 4821", "resolve incident number 4821", "add note to 4821 rolled back".
export function parseChatIntent(text: string, command?: string): { intent: ChatIntent; number?: number; rest: string } {
  const t = text.trim();
  const num = /(?:#|\bincident\s+(?:number\s+)?|\bnumber\s+|^|\s)(\d{2,})\b/i.exec(t);
  const number = num ? Number(num[1]) : undefined;
  const lower = t.toLowerCase();
  const pick = (): ChatIntent => {
    if (command && ['mine', 'ack', 'resolve', 'note', 'paige'].includes(command)) return command as ChatIntent;
    if (command === 'summary') return 'ask';
    if (/\b(ack|acknowledge|acknowledged)\b/.test(lower)) return 'ack';
    if (/\bresolve\b/.test(lower)) return 'resolve';
    if (/\b(add (a )?note|note that|note:)/.test(lower)) return 'note';
    if (/\bpaige\b/.test(lower)) return 'paige';
    if (/\b(my incidents|mine|assigned to me|what('s| is) open|anything open|am i on)\b/.test(lower)) return 'mine';
    return 'ask';
  };
  const intent = pick();
  let rest = t;
  if (intent === 'note') {
    rest = t
      .replace(/^.*?\b(add (a )?note( to)?|note that|note:)\s*/i, '')
      .replace(/^(incident\s+)?(number\s+)?#?\d{2,}\s*[:,-]?\s*/i, '')
      .trim();
  }
  return { intent, number, rest };
}

// Typed messages between the extension host and the incident pane.
// The host owns state; the pane renders it and sends intents back. Tokens never cross.

import type { Incident, IncidentDetail, Insights } from './model';

export type PaneTheme = 'auto' | 'light' | 'dark';

export interface PaneState {
  incident?: Incident;
  detail?: IncidentDetail;
  insights?: Insights;
  loading: boolean;
  insightsLoading: boolean;
  isMine: boolean;
  error?: string;
  pending: boolean;
  canWrite: boolean;
  readOnlyReason?: string;
  theme: PaneTheme;
  version: string;
  now: string;
  diagnostics: boolean;
}

// Sent once after the first render when diagnostics are on (extension tests), so the host can
// confirm the pane actually rendered under the real webview CSP.
export interface RenderReport {
  aboutButton: boolean;
  reducedMotionRule: boolean;
  actionCount: number;
}

export type HostMessage = { type: 'state'; state: PaneState };

// Every incident command the pane can trigger; each maps to `pagerduty.<action>`.
export const PANE_ACTIONS = [
  'acknowledge',
  'resolve',
  'escalate',
  'reassign',
  'snooze',
  'changeUrgency',
  'changePriority',
  'addResponders',
  'merge',
  'statusUpdate',
  'runWorkflow',
  'askPaige',
  'askAgent',
  'openInBrowser',
  'addFollowUp',
  'postmortemDraft',
  'copySummary',
  'incidentActions',
] as const;
export type PaneAction = (typeof PANE_ACTIONS)[number];

export type PaneMessage =
  | { type: 'ready' }
  | { type: 'rendered'; report: RenderReport }
  | { type: 'action'; action: PaneAction; workflowId?: string }
  | { type: 'addNote'; content: string }
  | { type: 'refresh' }
  | { type: 'openLink'; url: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openCommit'; hash: string; repoRoot: string }
  | { type: 'openIncident'; id: string };

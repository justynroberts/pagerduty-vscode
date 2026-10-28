// The only module that talks to PagerDuty. Surfaces ask the store, the store asks this.
// No vscode import, so it runs under vitest with a stubbed fetch.

import {
  ChangeEvent,
  Incident,
  IncidentDetail,
  IncidentStatus,
  Me,
  OnCall,
  Priority,
  Ref,
  RelatedIncident,
  WorkflowTrigger,
  normaliseChangeEvent,
  normaliseRelated,
  normaliseTrigger,
  normaliseAlert,
  normaliseIncident,
  normaliseLogEntry,
  normaliseMe,
  normaliseNote,
  normaliseOnCall,
} from './model';

export type Region = 'us' | 'eu';

export function regionHosts(region: Region): { api: string; app: string } {
  return region === 'eu'
    ? { api: 'https://api.eu.pagerduty.com', app: 'https://app.eu.pagerduty.com' }
    : { api: 'https://api.pagerduty.com', app: 'https://app.pagerduty.com' };
}

// The override exists for proxies and the end-to-end tests. Plain http is accepted only for loopback.
export function resolveApiBase(region: Region, override: string | undefined): string {
  const o = override?.trim();
  if (!o) return regionHosts(region).api;
  const u = new URL(o);
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new PdError('pagerduty.apiBaseUrl must use https.', 0);
  return o.replace(/\/+$/, '');
}

export interface Credentials {
  kind: 'oauth' | 'token';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
}

export class PdError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
  get isPermission(): boolean {
    return this.status === 403;
  }
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

export interface ClientOptions {
  apiBase: () => string;
  credentials: () => Promise<Credentials | undefined>;
  refresh: (c: Credentials) => Promise<Credentials | undefined>;
  fromEmail?: () => string | undefined;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

const MAX_RETRIES = 3;

export class PagerDutyClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: ClientOptions) {
    this.fetch = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    let creds = await this.o.credentials();
    if (!creds) throw new PdError('Not signed in to PagerDuty.', 401);
    const url = this.o.apiBase() + path + encodeQuery(opts.query);
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            Accept: 'application/vnd.pagerduty+json;version=2',
            Authorization: creds.kind === 'oauth' ? `Bearer ${creds.accessToken}` : `Token token=${creds.accessToken}`,
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(method !== 'GET' && this.o.fromEmail?.() ? { From: this.o.fromEmail()! } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (e) {
        throw new PdError(`Network error reaching PagerDuty: ${(e as Error).message}`, 0);
      }
      this.o.log?.(`${method} ${path} ${res.status} ${Date.now() - started}ms`);

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        await this.sleep(Math.min(wait, 30_000));
        continue;
      }
      if (res.status === 401 && !refreshed && creds.kind === 'oauth' && creds.refreshToken) {
        refreshed = true;
        const next = await this.o.refresh(creds);
        if (next) {
          creds = next;
          continue;
        }
      }
      if (!res.ok) throw await toError(res);
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }

  // Follows limit/offset paging up to max items.
  async paged<T>(path: string, key: string, query: Query = {}, max = 500): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; out.length < max; ) {
      const page = await this.request<Record<string, unknown>>('GET', path, { query: { ...query, limit: 100, offset } });
      const items = (page[key] as T[]) ?? [];
      out.push(...items);
      if (!page.more || items.length === 0) break;
      offset += items.length;
    }
    return out.slice(0, max);
  }

  async me(): Promise<Me> {
    const r = await this.request<{ user: unknown }>('GET', '/users/me', { query: { 'include[]': ['teams'] } });
    return normaliseMe(r.user);
  }

  async openIncidents(): Promise<Incident[]> {
    const raw = await this.paged('/incidents', 'incidents', { 'statuses[]': ['triggered', 'acknowledged'], date_range: 'all' });
    return raw.map(normaliseIncident);
  }

  // `since` filters on creation time, so this returns incidents created and resolved in the window.
  async resolvedSince(since: Date): Promise<Incident[]> {
    const raw = await this.paged('/incidents', 'incidents', { 'statuses[]': ['resolved'], since: since.toISOString() }, 200);
    return raw.map(normaliseIncident);
  }

  async incident(id: string): Promise<Incident> {
    const r = await this.request<{ incident: unknown }>('GET', `/incidents/${encodeURIComponent(id)}`);
    return normaliseIncident(r.incident);
  }

  async incidentDetail(id: string): Promise<IncidentDetail> {
    const base = `/incidents/${encodeURIComponent(id)}`;
    const [log, alerts, notes] = await Promise.all([
      this.paged(`${base}/log_entries`, 'log_entries', { is_overview: true }, 200),
      this.paged(`${base}/alerts`, 'alerts', {}, 100),
      this.request<{ notes: unknown[] }>('GET', `${base}/notes`),
    ]);
    return {
      log: log.map(normaliseLogEntry).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      alerts: alerts.map(normaliseAlert),
      notes: (notes.notes ?? []).map(normaliseNote).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      fetchedAt: new Date().toISOString(),
    };
  }

  async setStatus(id: string, status: IncidentStatus): Promise<Incident> {
    const r = await this.request<{ incident: unknown }>('PUT', `/incidents/${encodeURIComponent(id)}`, {
      body: { incident: { type: 'incident_reference', status } },
    });
    return normaliseIncident(r.incident);
  }

  // PUT /incidents/{id} for any field change: urgency, priority, escalation level, reassignment.
  async updateIncident(id: string, fields: Record<string, unknown>): Promise<Incident> {
    const r = await this.request<{ incident: unknown }>('PUT', `/incidents/${encodeURIComponent(id)}`, {
      body: { incident: { type: 'incident_reference', ...fields } },
    });
    return normaliseIncident(r.incident);
  }

  async addNote(id: string, content: string): Promise<void> {
    await this.request('POST', `/incidents/${encodeURIComponent(id)}/notes`, { body: { note: { content } } });
  }

  async snooze(id: string, seconds: number): Promise<Incident> {
    const r = await this.request<{ incident: unknown }>('POST', `/incidents/${encodeURIComponent(id)}/snooze`, { body: { duration: seconds } });
    return normaliseIncident(r.incident);
  }

  async merge(targetId: string, sourceIds: string[]): Promise<Incident> {
    const r = await this.request<{ incident: unknown }>('PUT', `/incidents/${encodeURIComponent(targetId)}/merge`, {
      body: { source_incidents: sourceIds.map((id) => ({ id, type: 'incident_reference' })) },
    });
    return normaliseIncident(r.incident);
  }

  async statusUpdate(id: string, message: string): Promise<void> {
    await this.request('POST', `/incidents/${encodeURIComponent(id)}/status_updates`, { body: { message } });
  }

  async requestResponders(id: string, requesterId: string, message: string, targets: { id: string; type: 'user' | 'escalation_policy' }[]): Promise<void> {
    await this.request('POST', `/incidents/${encodeURIComponent(id)}/responder_requests`, {
      body: {
        requester_id: requesterId,
        message,
        responder_request_targets: targets.map((t) => ({ responder_request_target: { id: t.id, type: `${t.type}_reference` } })),
      },
    });
  }

  async searchUsers(query: string): Promise<{ id: string; name: string; email: string }[]> {
    const r = await this.request<{ users: { id: string; name: string; email: string }[] }>('GET', '/users', { query: { query, limit: 25 } });
    return r.users.map((u) => ({ id: u.id, name: u.name, email: u.email }));
  }

  async searchEscalationPolicies(query: string): Promise<Ref[]> {
    const r = await this.request<{ escalation_policies: { id: string; name: string }[] }>('GET', '/escalation_policies', { query: { query, limit: 25 } });
    return r.escalation_policies.map((p) => ({ id: p.id, name: p.name }));
  }

  // Levels of an escalation policy, each with a readable list of its targets.
  async escalationLevels(policyId: string): Promise<{ level: number; targets: string }[]> {
    const r = await this.request<{ escalation_policy: { escalation_rules?: { targets?: { summary?: string }[] }[] } }>(
      'GET',
      `/escalation_policies/${encodeURIComponent(policyId)}`,
    );
    return (r.escalation_policy.escalation_rules ?? []).map((rule, i) => ({
      level: i + 1,
      targets: (rule.targets ?? []).map((t) => t.summary ?? '').filter(Boolean).join(', '),
    }));
  }

  async priorities(): Promise<Priority[]> {
    const raw = await this.paged<{ id: string; name: string; description?: string }>('/priorities', 'priorities', {}, 50);
    return raw.map((p) => ({ id: p.id, name: p.name, description: p.description }));
  }

  async relatedChangeEvents(id: string): Promise<ChangeEvent[]> {
    const r = await this.request<{ change_events: unknown[] }>('GET', `/incidents/${encodeURIComponent(id)}/related_change_events`, { query: { limit: 25 } });
    return (r.change_events ?? []).map(normaliseChangeEvent);
  }

  async pastIncidents(id: string): Promise<RelatedIncident[]> {
    const r = await this.request<{ past_incidents: { incident: unknown; score?: number }[] }>('GET', `/incidents/${encodeURIComponent(id)}/past_incidents`, {
      query: { limit: 10 },
    });
    return (r.past_incidents ?? []).map((p) => normaliseRelated(p.incident, p.score));
  }

  async relatedIncidents(id: string): Promise<RelatedIncident[]> {
    const r = await this.request<{ related_incidents: { incident: unknown }[] }>('GET', `/incidents/${encodeURIComponent(id)}/related_incidents`, {
      query: { 'additional_details[]': ['incident'] },
    });
    return (r.related_incidents ?? []).map((p) => normaliseRelated(p.incident));
  }

  async outlierIncident(id: string): Promise<RelatedIncident | undefined> {
    const r = await this.request<{ outlier_incident?: { incident?: unknown } }>('GET', `/incidents/${encodeURIComponent(id)}/outlier_incident`, {
      query: { 'additional_details[]': ['incident'] },
    });
    return r.outlier_incident?.incident ? normaliseRelated(r.outlier_incident.incident) : undefined;
  }

  // Workflows a responder can start by hand on this incident (its service's manual triggers).
  async manualWorkflows(incidentId: string): Promise<WorkflowTrigger[]> {
    const r = await this.request<{ triggers: unknown[] }>('GET', '/incident_workflows/triggers', {
      query: { incident_id: incidentId, trigger_type: 'manual', limit: 100 },
    });
    return (r.triggers ?? []).map(normaliseTrigger);
  }

  async startWorkflow(workflowId: string, incidentId: string): Promise<void> {
    await this.request('POST', `/incident_workflows/${encodeURIComponent(workflowId)}/instances`, {
      body: { incident_workflow_instance: { type: 'incident_workflow_instance', incident: { id: incidentId, type: 'incident_reference' } } },
    });
  }

  async oncalls(policyIds?: string[]): Promise<OnCall[]> {
    const raw = await this.paged('/oncalls', 'oncalls', { earliest: true, 'escalation_policy_ids[]': policyIds }, policyIds ? 100 : 300);
    return raw.map(normaliseOnCall);
  }

  async servicePolicyId(serviceId: string): Promise<string> {
    const r = await this.request<{ service: { escalation_policy?: { id: string } } }>('GET', `/services/${encodeURIComponent(serviceId)}`);
    const id = r.service.escalation_policy?.id;
    if (!id) throw new PdError(`Service ${serviceId} has no escalation policy.`, 404);
    return id;
  }
}

export function encodeQuery(q: Query | undefined): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function toError(res: Response): Promise<PdError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: string[] } };
    detail = [body.error?.message, ...(body.error?.errors ?? [])].filter(Boolean).join(': ');
  } catch {
    // Non-JSON error bodies fall back to the status text.
  }
  if (res.status === 402) return new PdError(`Not included in this PagerDuty plan${detail ? ` (${detail})` : ''}.`, 402);
  if (res.status === 403) return new PdError(`Your PagerDuty role doesn't allow this${detail ? ` (${detail})` : ''}.`, 403);
  if (res.status === 401) return new PdError('PagerDuty rejected the credentials. Sign in again.', 401);
  return new PdError(detail || `PagerDuty returned ${res.status} ${res.statusText}`, res.status);
}

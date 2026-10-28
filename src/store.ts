// Single source of state for every surface. One poll loop serves all views and panels,
// so ten open panes still mean one request per interval.

import * as vscode from 'vscode';
import { PagerDutyClient, PdError } from './api';
import { AuditLog } from './audit';
import { DEFAULT_FILTER, Filter, Incident, IncidentDetail, IncidentStatus, Insights, Me, OnCall, Slot } from './model';
import { CodeContext } from './codeContext';

const CACHE_KEY = 'pagerduty.cache.v1';
const FILTER_KEY = 'pagerduty.filter.v1';
const UNFOCUSED_INTERVAL_MS = 120_000;
const RESOLVED_WINDOW_MS = 24 * 3600_000;
const DETAIL_MAX_AGE_MS = 60_000;

interface Cache {
  me: Me;
  incidents: Incident[];
  oncalls: OnCall[];
}

export interface ServiceOnCall {
  serviceId: string;
  names: string[];
}

export class Store implements vscode.Disposable {
  me?: Me;
  incidents = new Map<string, Incident>();
  oncalls: OnCall[] = [];
  serviceOnCall?: ServiceOnCall;
  serviceId?: string;
  filter: Filter;
  error?: string;
  lastSync?: Date;
  readonly pending = new Set<string>();
  readonly details = new Map<string, IncidentDetail>();
  readonly detailErrors = new Map<string, string>();
  readonly loadingDetail = new Set<string>();
  readonly insights = new Map<string, Insights>();
  readonly loadingInsights = new Set<string>();

  private readonly watched = new Set<string>();
  private readonly detailStamp = new Map<string, string>();
  private readonly seen = new Set<string>();
  private seeded = false;
  private running = false;
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<void>;
  private pollCount = 0;
  private servicePolicy?: { serviceId: string; policyId: string };

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly newAssigned = new vscode.EventEmitter<Incident[]>();
  readonly onNewAssigned = this.newAssigned.event;
  private readonly unauthorized = new vscode.EventEmitter<void>();
  readonly onUnauthorized = this.unauthorized.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly api: PagerDutyClient,
    private readonly audit: AuditLog,
    private readonly log: vscode.LogOutputChannel,
    private readonly code: CodeContext,
  ) {
    this.filter = ctx.globalState.get<Filter>(FILTER_KEY) ?? DEFAULT_FILTER;
    this.disposables.push(
      this.changed,
      this.newAssigned,
      this.unauthorized,
      vscode.window.onDidChangeWindowState((s) => {
        if (!this.running) return;
        // Coming back to the window: refresh if the last poll is older than the focused interval.
        if (s.focused && (!this.lastSync || Date.now() - this.lastSync.getTime() > this.focusedInterval())) void this.sync();
        else this.schedule();
      }),
    );
  }

  get signedIn(): boolean {
    return this.running;
  }

  get(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  start(me: Me): void {
    const cache = this.ctx.globalState.get<Cache>(CACHE_KEY);
    if (cache && cache.me.id === me.id) {
      this.incidents = new Map(cache.incidents.map((i) => [i.id, i]));
      this.oncalls = cache.oncalls;
    }
    this.me = me;
    this.running = true;
    this.changed.fire();
    void this.sync();
  }

  // Shows the cached list on cold start, before credentials are even checked.
  restoreCache(): void {
    const cache = this.ctx.globalState.get<Cache>(CACHE_KEY);
    if (!cache) return;
    this.me = cache.me;
    this.incidents = new Map(cache.incidents.map((i) => [i.id, i]));
    this.oncalls = cache.oncalls;
    this.changed.fire();
  }

  async stop(clearCache: boolean): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    if (clearCache) {
      await this.ctx.globalState.update(CACHE_KEY, undefined);
      this.me = undefined;
      this.incidents.clear();
      this.oncalls = [];
      this.details.clear();
      this.insights.clear();
      this.serviceOnCall = undefined;
      this.seen.clear();
      this.seeded = false;
    }
    this.changed.fire();
  }

  async setFilter(f: Filter): Promise<void> {
    const needsResolved = f.statuses.includes('resolved') && !this.filter.statuses.includes('resolved');
    this.filter = f;
    await this.ctx.globalState.update(FILTER_KEY, f);
    this.changed.fire();
    if (needsResolved) void this.sync();
  }

  setServiceId(id: string | undefined): void {
    if (id === this.serviceId) return;
    this.serviceId = id;
    this.serviceOnCall = undefined;
    this.changed.fire();
    if (this.running) void this.syncServiceOnCall();
  }

  watch(id: string): void {
    this.watched.add(id);
  }

  unwatch(id: string): void {
    this.watched.delete(id);
  }

  // Set by the push relay: while live, events drive syncs and polling is only a safety net.
  live = false;

  setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    this.schedule();
  }

  isWatched(id: string): boolean {
    return this.watched.has(id);
  }

  private focusedInterval(): number {
    if (this.live) return UNFOCUSED_INTERVAL_MS;
    const s = vscode.workspace.getConfiguration('pagerduty').get<number>('pollIntervalSeconds', 30);
    return Math.max(15, s) * 1000;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.running) return;
    const ms = vscode.window.state.focused ? this.focusedInterval() : UNFOCUSED_INTERVAL_MS;
    this.timer = setTimeout(() => void this.sync(), ms);
  }

  sync(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.inflight ??= this.doSync().finally(() => {
      this.inflight = undefined;
      this.schedule();
    });
    return this.inflight;
  }

  private async doSync(): Promise<void> {
    const poll = this.pollCount++;
    try {
      if (!this.me || poll % 20 === 19) this.me = await this.api.me();
      const wantResolved = this.filter.statuses.includes('resolved');
      const [open, resolved] = await Promise.all([
        this.api.openIncidents(),
        wantResolved ? this.api.resolvedSince(new Date(Date.now() - RESOLVED_WINDOW_MS)) : Promise.resolve([]),
      ]);

      const next = new Map<string, Incident>();
      for (const i of [...open, ...resolved]) next.set(i.id, this.pending.has(i.id) ? (this.incidents.get(i.id) ?? i) : i);
      // Panels can show incidents that dropped out of the list (resolved elsewhere): fetch those individually.
      for (const id of this.watched) {
        if (!next.has(id)) {
          try {
            next.set(id, await this.api.incident(id));
          } catch (e) {
            this.log.warn(`Could not refresh watched incident ${id}: ${(e as Error).message}`);
          }
        }
      }
      this.incidents = next;
      this.notifyNew(open);

      if (poll % 4 === 0) {
        this.oncalls = (await this.api.oncalls()).filter((o) => o.level === 1);
        await this.syncServiceOnCall(false);
      }
      this.error = undefined;
      this.lastSync = new Date();
      await this.persist();

      for (const id of this.watched) {
        const inc = this.incidents.get(id);
        const fetchedAt = this.details.get(id)?.fetchedAt;
        const stale = !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > DETAIL_MAX_AGE_MS;
        if (inc && (stale || this.detailStamp.get(id) !== inc.updatedAt)) void this.loadDetail(id);
      }
    } catch (e) {
      this.error = (e as Error).message;
      this.log.error(`Sync failed: ${this.error}`);
      if (e instanceof PdError && e.status === 401) this.unauthorized.fire();
    }
    this.changed.fire();
  }

  private notifyNew(open: Incident[]): void {
    const me = this.me;
    const fresh = open.filter((i) => !this.seen.has(i.id));
    fresh.forEach((i) => this.seen.add(i.id));
    // The first poll after start seeds the seen set so existing incidents don't all pop up.
    if (!this.seeded) {
      this.seeded = true;
      return;
    }
    const mine = fresh.filter((i) => i.status === 'triggered' && me && i.assignees.some((a) => a.id === me.id));
    if (mine.length) this.newAssigned.fire(mine);
  }

  private async syncServiceOnCall(fire = true): Promise<void> {
    const serviceId = this.serviceId;
    if (!serviceId) return;
    try {
      if (this.servicePolicy?.serviceId !== serviceId) {
        this.servicePolicy = { serviceId, policyId: await this.api.servicePolicyId(serviceId) };
      }
      const oncalls = await this.api.oncalls([this.servicePolicy.policyId]);
      const names = [...new Set(oncalls.filter((o) => o.level === 1).map((o) => o.user.name))];
      this.serviceOnCall = { serviceId, names };
    } catch (e) {
      this.log.warn(`On-call lookup for ${serviceId} failed: ${(e as Error).message}`);
    }
    if (fire) this.changed.fire();
  }

  async loadDetail(id: string): Promise<void> {
    if (this.loadingDetail.has(id)) return;
    this.loadingDetail.add(id);
    this.changed.fire();
    try {
      if (!this.incidents.has(id)) this.incidents.set(id, await this.api.incident(id));
      const detail = await this.api.incidentDetail(id);
      this.details.set(id, detail);
      this.detailStamp.set(id, this.incidents.get(id)!.updatedAt);
      this.detailErrors.delete(id);
    } catch (e) {
      this.detailErrors.set(id, (e as Error).message);
    } finally {
      this.loadingDetail.delete(id);
      this.changed.fire();
    }
  }

  // AIOps insights, change events, Paige workflows and local code context. Each source fails on its own,
  // so a plan without Event Intelligence still gets commits and change events.
  async loadInsights(id: string): Promise<void> {
    if (this.loadingInsights.has(id)) return;
    this.loadingInsights.add(id);
    this.changed.fire();
    try {
      if (!this.details.has(id)) await this.loadDetail(id);
      const incident = this.incidents.get(id);
      if (!incident) return;
      const [changes, past, related, outlier, paige, code] = await Promise.all([
        slot(this.api.relatedChangeEvents(id)),
        slot(this.api.pastIncidents(id)),
        slot(this.api.relatedIncidents(id)),
        this.api.outlierIncident(id).catch(() => undefined),
        slot(this.api.manualWorkflows(id)),
        this.code.gather(incident, this.details.get(id)),
      ]);
      this.insights.set(id, { changes, past, related, outlier, paige, ...code, fetchedAt: new Date().toISOString() });
    } catch (e) {
      this.log.warn(`Insights for ${id} failed: ${(e as Error).message}`);
    } finally {
      this.loadingInsights.delete(id);
      this.changed.fire();
    }
  }

  // Every write that isn't a status change goes through here: pending state, audit, then re-read.
  async mutate(id: string, action: string, fn: () => Promise<Incident | void>): Promise<PdError | undefined> {
    const prev = this.incidents.get(id);
    this.pending.add(id);
    this.changed.fire();
    try {
      const updated = await fn();
      if (updated) this.incidents.set(id, updated);
      this.audit.record({ incident: id, number: prev?.number ?? 0, action, outcome: 'ok' });
      return undefined;
    } catch (e) {
      const error = e instanceof PdError ? e : new PdError((e as Error).message, 0);
      this.audit.record({ incident: id, number: prev?.number ?? 0, action, outcome: 'failed', error: error.message });
      return error;
    } finally {
      this.pending.delete(id);
      this.changed.fire();
      if (this.watched.has(id)) void this.loadDetail(id);
    }
  }

  // Optimistic: apply locally, call the API, roll back on failure. Returns the failures.
  async setStatus(ids: string[], status: IncidentStatus): Promise<{ incident: Incident; error: PdError }[]> {
    const targets = ids.map((id) => this.incidents.get(id)).filter((i): i is Incident => !!i && !this.pending.has(i.id));
    for (const i of targets) {
      this.pending.add(i.id);
      this.incidents.set(i.id, { ...i, status });
    }
    this.changed.fire();

    const failures: { incident: Incident; error: PdError }[] = [];
    await Promise.all(
      targets.map(async (prev) => {
        const action = status === 'acknowledged' ? 'acknowledge' : status === 'resolved' ? 'resolve' : status;
        try {
          const updated = await this.api.setStatus(prev.id, status);
          this.incidents.set(prev.id, updated);
          this.audit.record({ incident: prev.id, number: prev.number, action, outcome: 'ok' });
        } catch (e) {
          const error = e instanceof PdError ? e : new PdError((e as Error).message, 0);
          this.incidents.set(prev.id, prev);
          failures.push({ incident: prev, error });
          this.audit.record({ incident: prev.id, number: prev.number, action, outcome: 'failed', error: error.message });
        } finally {
          this.pending.delete(prev.id);
        }
      }),
    );
    this.changed.fire();
    for (const t of targets) if (this.watched.has(t.id)) void this.loadDetail(t.id);
    return failures;
  }

  private async persist(): Promise<void> {
    if (!this.me) return;
    const cache: Cache = {
      me: this.me,
      incidents: [...this.incidents.values()].filter((i) => i.status !== 'resolved'),
      oncalls: this.oncalls,
    };
    await this.ctx.globalState.update(CACHE_KEY, cache);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}

async function slot<T>(p: Promise<T[]>): Promise<Slot<T>> {
  try {
    return { items: await p };
  } catch (e) {
    const status = e instanceof PdError ? e.status : 0;
    const unavailable =
      status === 402
        ? 'Not included in this PagerDuty plan.'
        : status === 403
          ? 'Your role or token scope can’t read this.'
          : status === 404
            ? 'Not available for this incident.'
            : (e as Error).message;
    return { items: [], unavailable };
  }
}

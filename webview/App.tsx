import { Fragment, KeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { PAIGE_AUTHOR, FOLLOW_UP_PREFIX, followUpText, formatAge, Incident, IncidentDetail, Insights, isFollowUp, RelatedIncident, STATUS_LABEL } from '../src/model';
import type { HostMessage, PaneAction, PaneMessage, PaneState } from '../src/protocol';
import { Check, CheckAll, Close, Copy, External, Info, KindMarker, Refresh, Sparkle, StatusShape } from './icons';

declare function acquireVsCodeApi(): { postMessage(m: PaneMessage): void };
const vscode = acquireVsCodeApi();
const send = (m: PaneMessage) => vscode.postMessage(m);
const act = (action: PaneAction, workflowId?: string) => send({ type: 'action', action, workflowId });

const MAX_DETAILS_CHARS = 20_000;

export function App() {
  const [state, setState] = useState<PaneState>();
  const [announce, setAnnounce] = useState('');
  const lastStatus = useRef<string>();

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostMessage>) => {
      if (e.data?.type === 'state') setState(e.data.state);
    };
    window.addEventListener('message', onMessage);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = state?.theme ?? 'auto';
  }, [state?.theme]);

  // Announce status changes to screen readers, but not the first render.
  const status = state?.incident?.status;
  useEffect(() => {
    if (status && lastStatus.current && lastStatus.current !== status) setAnnounce(`Incident ${STATUS_LABEL[status].toLowerCase()}.`);
    lastStatus.current = status;
  }, [status]);

  // Diagnostics (extension tests only): report what actually rendered.
  const reported = useRef(false);
  useEffect(() => {
    if (!state?.diagnostics || !state.incident || reported.current) return;
    reported.current = true;
    const rules = [...document.styleSheets].flatMap((sh) => {
      try {
        return [...sh.cssRules];
      } catch {
        return [];
      }
    });
    send({
      type: 'rendered',
      report: {
        aboutButton: !!document.querySelector('button[aria-label="About this app"]'),
        reducedMotionRule: rules.some((r) => r instanceof CSSMediaRule && r.conditionText.includes('prefers-reduced-motion')),
        actionCount: document.querySelectorAll('[role="toolbar"] button').length,
      },
    });
  }, [state]);

  const incident = state?.incident;
  return (
    <div className="shell">
      {!state || !incident ? (
        <p className="empty">{state?.error ? `Couldn't load the incident: ${state.error}` : 'Loading incident…'}</p>
      ) : (
        <>
          <Header state={state} incident={incident} />
          <main className="body">
            <div className="main">
              <Paige state={state} />
              <Timeline detail={state.detail} loading={state.loading} />
              <Changes insights={state.insights} loading={state.insightsLoading} />
            </div>
            <aside className="rail" aria-label="Incident details">
              <Responders incident={incident} canWrite={state.canWrite} />
              <LikelyFiles insights={state.insights} loading={state.insightsLoading} />
              <FollowUps detail={state.detail} canWrite={state.canWrite} pending={state.pending} />
              <Notes detail={state.detail} canWrite={state.canWrite} pending={state.pending} />
              <Alerts detail={state.detail} />
              <Similar insights={state.insights} loading={state.insightsLoading} />
            </aside>
          </main>
        </>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

function Header({ state, incident }: { state: PaneState; incident: Incident }) {
  const now = new Date(state.now);
  const open = incident.status !== 'resolved';
  const busy = state.pending;
  return (
    <header className="head">
      <div className="meta">
        <span className={`status status-${incident.status}`}>
          <StatusShape status={incident.status} />
          {busy ? 'Updating…' : STATUS_LABEL[incident.status]}
        </span>
        <span className="num">#{incident.number}</span>
        <span className={`urgency urgency-${incident.urgency}`}>{incident.urgency === 'high' ? 'High urgency' : 'Low urgency'}</span>
        {incident.priority && <span className="priority">{incident.priority}</span>}
        <span className="service">{incident.service.name}</span>
        <span className="muted">
          opened <time dateTime={incident.createdAt} title={new Date(incident.createdAt).toLocaleString()}>{formatAge(incident.createdAt, now)} ago</time>
        </span>
        {state.isMine && <span className="mine">Assigned to you</span>}
        <span className="spacer" />
        {(state.loading || state.insightsLoading) && <span className="muted mono">refreshing</span>}
        <button className="icon-btn" aria-label="Copy summary" title="Copy summary for Slack or a ticket" onClick={() => act('copySummary')}>
          <Copy />
        </button>
        <button className="icon-btn" aria-label="Open in PagerDuty" title="Open in PagerDuty" onClick={() => act('openInBrowser')}>
          <External />
        </button>
        <button className="icon-btn" aria-label="Refresh" title="Refresh" onClick={() => send({ type: 'refresh' })} disabled={state.loading}>
          <Refresh />
        </button>
        <AboutButton version={state.version} />
      </div>
      <h1>{incident.title}</h1>
      <div className="actions" role="toolbar" aria-label="Incident actions">
        {state.canWrite && open && (
          <>
            <button className="primary" disabled={busy || incident.status !== 'triggered'} onClick={() => act('acknowledge')}>
              <Check /> Acknowledge
            </button>
            <button disabled={busy} onClick={() => act('resolve')}>
              <CheckAll /> Resolve
            </button>
            <span className="sep" aria-hidden="true" />
            <button disabled={busy} onClick={() => act('reassign')}>Reassign</button>
            <button disabled={busy} onClick={() => act('escalate')}>Escalate</button>
            <button disabled={busy} onClick={() => act('addResponders')}>Add responders</button>
            {incident.status === 'acknowledged' && (
              <button disabled={busy} onClick={() => act('snooze')}>
                Snooze
              </button>
            )}
            <button disabled={busy} onClick={() => act('statusUpdate')}>Status update</button>
          </>
        )}
        <button onClick={() => act('incidentActions')} title="Urgency, priority, merge, workflows and everything else (PagerDuty: Incident Actions…)">
          More…
        </button>
        {!state.canWrite && <span className="muted">{state.readOnlyReason}</span>}
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </header>
  );
}

function when(iso: string): { short: string; full: string } {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return { short: today ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`, full: d.toLocaleString() };
}

// Paige: start the Paige virtual responder, and surface what Paige has written on the incident.
function Paige({ state }: { state: PaneState }) {
  const slot = state.insights?.paige;
  const paigeFlows = slot?.items.filter((t) => /paige|sre agent/i.test(t.workflowName)) ?? [];
  const paigeNotes = state.detail?.notes.filter((n) => PAIGE_AUTHOR.test(n.author)) ?? [];
  const paigeLog = state.detail?.log.filter((l) => l.agent && PAIGE_AUTHOR.test(l.agent)) ?? [];
  return (
    <section className="paige" aria-labelledby="h-paige">
      <div className="section-head">
        <h2 id="h-paige">
          <Sparkle /> Paige
        </h2>
        <div className="row">
          {state.canWrite && (
            <button className="ai" onClick={() => act('askPaige')} disabled={state.pending}>
              <Sparkle /> Ask Paige to investigate
            </button>
          )}
          <button onClick={() => act('askAgent')}>Ask editor agent</button>
        </div>
      </div>
      {!slot ? (
        <p className="muted">{state.insightsLoading ? 'Checking Paige availability…' : ''}</p>
      ) : slot.unavailable ? (
        <p className="muted">Incident workflows: {slot.unavailable}</p>
      ) : paigeFlows.length === 0 ? (
        <p className="muted">
          No Paige workflow on this service yet. Add the “Paige virtual responder” incident workflow with a manual trigger to run Paige from here. The editor agent works either way.
        </p>
      ) : (
        <p className="muted">Paige posts findings, likely causes and next steps to the incident. They appear below as they land.</p>
      )}
      {(paigeNotes.length > 0 || paigeLog.length > 0) && (
        <ul className="stack findings">
          {paigeNotes.map((n) => (
            <li key={n.id}>
              <div className="byline">
                <strong>{n.author}</strong> <span className="mono muted">{when(n.createdAt).short}</span>
              </div>
              <p className="prose">
                <Linkified text={n.content} />
              </p>
            </li>
          ))}
          {paigeLog.map((l) => (
            <li key={l.id}>
              <div className="byline">
                <strong>{l.agent}</strong> <span className="mono muted">{when(l.createdAt).short}</span>
              </div>
              <p className="prose">
                <Linkified text={l.summary} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Timeline({ detail, loading }: { detail?: IncidentDetail; loading: boolean }) {
  return (
    <section className="timeline" aria-labelledby="h-timeline">
      <h2 id="h-timeline">Timeline</h2>
      {!detail ? (
        <p className="muted">{loading ? 'Loading timeline…' : 'No timeline yet.'}</p>
      ) : (
        <ol>
          {detail.log.map((e) => {
            const t = when(e.createdAt);
            return (
              <li key={e.id} className={`entry kind-${e.kind}`}>
                <time className="mono muted" dateTime={e.createdAt} title={t.full}>
                  {t.short}
                </time>
                <span className="marker">
                  <KindMarker kind={e.kind} />
                </span>
                <span className="summary">
                  <Linkified text={e.summary} />
                  {e.agent && <span className="muted"> · {e.agent}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// Change events PagerDuty correlated with the incident, plus local commits in the window before it.
function Changes({ insights, loading }: { insights?: Insights; loading: boolean }) {
  return (
    <section aria-labelledby="h-changes">
      <h2 id="h-changes">Recent changes</h2>
      {!insights ? (
        <p className="muted">{loading ? 'Looking for deploys and commits…' : ''}</p>
      ) : (
        <>
          <h3>From PagerDuty change events</h3>
          {insights.changes.unavailable ? (
            <p className="muted">{insights.changes.unavailable}</p>
          ) : insights.changes.items.length === 0 ? (
            <p className="muted">No correlated change events.</p>
          ) : (
            <ol className="entries">
              {insights.changes.items.map((c) => (
                <li key={c.id} className="entry">
                  <time className="mono muted" dateTime={c.timestamp} title={when(c.timestamp).full}>
                    {when(c.timestamp).short}
                  </time>
                  <span className="marker">
                    <KindMarker kind="change" />
                  </span>
                  <span className="summary">
                    {c.summary}
                    {c.source && <span className="muted"> · {c.source}</span>}
                    {c.reason && <span className="tag">{c.reason.replace('_', ' ')}</span>}
                    {c.links.slice(0, 3).map((l) => (
                      <Fragment key={l.href}>
                        {' '}
                        <button className="link inline" onClick={() => send({ type: 'openLink', url: l.href })}>
                          {l.text}
                        </button>
                      </Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <h3>Commits before it triggered (this workspace)</h3>
          {insights.commits.unavailable ? (
            <p className="muted">{insights.commits.unavailable}</p>
          ) : insights.commits.items.length === 0 ? (
            <p className="muted">No commits in the window before the trigger time.</p>
          ) : (
            <ol className="entries">
              {insights.commits.items.map((c) => (
                <li key={c.hash} className="entry">
                  <time className="mono muted" dateTime={c.date} title={when(c.date).full}>
                    {when(c.date).short}
                  </time>
                  <span className="marker">
                    <KindMarker kind="commit" />
                  </span>
                  <span className="summary">
                    <button className="link inline mono" onClick={() => send({ type: 'openCommit', hash: c.hash, repoRoot: c.repoRoot })} title="Open the diff">
                      {c.hash.slice(0, 7)}
                    </button>{' '}
                    {c.message}
                    {c.author && <span className="muted"> · {c.author}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function Responders({ incident, canWrite }: { incident: Incident; canWrite: boolean }) {
  return (
    <section aria-labelledby="h-responders">
      <div className="section-head">
        <h2 id="h-responders">Responders</h2>
        {canWrite && incident.status !== 'resolved' && (
          <button className="link" onClick={() => act('addResponders')}>
            Add
          </button>
        )}
      </div>
      <dl className="pairs">
        <dt>Assigned</dt>
        <dd>{incident.assignees.length ? incident.assignees.map((a) => a.name).join(', ') : <span className="muted">Nobody</span>}</dd>
        {incident.acknowledgers.length > 0 && (
          <>
            <dt>Acknowledged</dt>
            <dd>
              {incident.acknowledgers.map((a, i) => (
                <Fragment key={`${a.id}-${i}`}>
                  {i > 0 && ', '}
                  {a.name} <span className="mono muted">{when(a.at).short}</span>
                </Fragment>
              ))}
            </dd>
          </>
        )}
        <dt>Escalation</dt>
        <dd>{incident.escalationPolicy.name || <span className="muted">None</span>}</dd>
      </dl>
    </section>
  );
}

function LikelyFiles({ insights, loading }: { insights?: Insights; loading: boolean }) {
  const slot = insights?.likelyFiles;
  return (
    <section aria-labelledby="h-files">
      <h2 id="h-files">Likely files</h2>
      {!slot ? (
        <p className="muted">{loading ? 'Matching alerts and commits to files…' : ''}</p>
      ) : slot.unavailable ? (
        <p className="muted">{slot.unavailable}</p>
      ) : slot.items.length === 0 ? (
        <p className="muted">Nothing in the alerts or recent commits points at a file here.</p>
      ) : (
        <>
          <p className="muted small">Suggestions, not a verdict.</p>
          <ul className="files">
            {slot.items.map((f) => (
              <li key={f.path}>
                <button className="link mono" onClick={() => send({ type: 'openFile', path: f.path, line: f.line })}>
                  {f.label}
                  {f.line ? `:${f.line}` : ''}
                </button>
                <span className="muted small">{f.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function NoteComposer({ pending, prefix = '', id, placeholder, button, rows = 3 }: { pending: boolean; prefix?: string; id: string; placeholder: string; button: string; rows?: number }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim()) return;
    send({ type: 'addNote', content: prefix ? `${prefix} ${text.trim()}` : text.trim() });
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="composer">
      <label htmlFor={id} className="sr-only">
        {button}
      </label>
      <textarea id={id} rows={rows} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      <button onClick={submit} disabled={pending || !text.trim()}>
        {button}
      </button>
    </div>
  );
}

// Follow-ups are notes prefixed "Follow-up:", so they stay with the incident in PagerDuty.
function FollowUps({ detail, canWrite, pending }: { detail?: IncidentDetail; canWrite: boolean; pending: boolean }) {
  const items = detail?.notes.filter(isFollowUp) ?? [];
  return (
    <section aria-labelledby="h-followups">
      <div className="section-head">
        <h2 id="h-followups">
          Follow-ups <span className="count">{detail ? items.length : ''}</span>
        </h2>
      </div>
      {canWrite && <NoteComposer pending={pending} prefix={FOLLOW_UP_PREFIX} id="followup" placeholder="Something to fix after this incident" button="Add follow-up" rows={2} />}
      {items.length > 0 && (
        <ul className="files">
          {items.map((n) => (
            <li key={n.id}>
              <span>{followUpText(n)}</span>
              <span className="muted small">
                {n.author} · {when(n.createdAt).short}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Notes({ detail, canWrite, pending }: { detail?: IncidentDetail; canWrite: boolean; pending: boolean }) {
  return (
    <section aria-labelledby="h-notes">
      <h2 id="h-notes">
        Notes <span className="count">{detail?.notes.length ?? ''}</span>
      </h2>
      {canWrite && <NoteComposer pending={pending} id="note" placeholder="Add a note for everyone on the incident (Ctrl/Cmd+Enter)" button="Add note" />}
      {detail && detail.notes.filter((n) => !isFollowUp(n)).length === 0 && <p className="muted">No notes yet.</p>}
      {detail && detail.notes.length > 0 && (
        <ul className="stack">
          {detail.notes.filter((n) => !isFollowUp(n)).map((n) => (
            <li key={n.id}>
              <div className="byline">
                <strong>{n.author}</strong> <span className="mono muted">{when(n.createdAt).short}</span>
              </div>
              <p className="prose">
                <Linkified text={n.content} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Alerts({ detail }: { detail?: IncidentDetail }) {
  if (!detail) return null;
  return (
    <section aria-labelledby="h-alerts">
      <h2 id="h-alerts">
        Alerts <span className="count">{detail.alerts.length}</span>
      </h2>
      <ul className="stack">
        {detail.alerts.map((a) => (
          <li key={a.id}>
            <div className="byline">
              {a.severity && <span className={`sev sev-${a.severity}`}>{a.severity}</span>}
              <span className="muted">{a.status}</span> <span className="mono muted">{when(a.createdAt).short}</span>
            </div>
            <p className="prose">{a.summary}</p>
            {a.details && (
              <details>
                <summary>Details</summary>
                <pre>{a.details.length > MAX_DETAILS_CHARS ? `${a.details.slice(0, MAX_DETAILS_CHARS)}\n… truncated` : a.details}</pre>
              </details>
            )}
            {a.htmlUrl && (
              <button className="link" onClick={() => send({ type: 'openLink', url: a.htmlUrl! })}>
                View alert in PagerDuty
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// AIOps: outlier, related (happening now elsewhere) and past (similar, resolved) incidents.
function Similar({ insights, loading }: { insights?: Insights; loading: boolean }) {
  const list = (items: RelatedIncident[], showScore: boolean) => (
    <ul className="files">
      {items.map((r) => (
        <li key={r.id}>
          <button className="link" onClick={() => send({ type: 'openIncident', id: r.id })}>
            {r.number ? `#${r.number} ` : ''}
            {r.title}
          </button>
          <span className="muted small">
            {[r.status, r.createdAt && when(r.createdAt).short, showScore && r.score !== undefined && `similarity ${Math.round(r.score * (r.score <= 1 ? 100 : 1))}`]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-labelledby="h-similar">
      <h2 id="h-similar">
        <Sparkle /> Insights
      </h2>
      {!insights ? (
        <p className="muted">{loading ? 'Loading AIOps insights…' : ''}</p>
      ) : (
        <>
          {insights.outlier && (
            <p>
              <span className="tag">outlier</span> This incident is unusual for its service.
            </p>
          )}
          <h3>Related, happening now</h3>
          {insights.related.unavailable ? (
            <p className="muted">{insights.related.unavailable}</p>
          ) : insights.related.items.length ? (
            list(insights.related.items, false)
          ) : (
            <p className="muted">None.</p>
          )}
          <h3>Similar past incidents</h3>
          {insights.past.unavailable ? (
            <p className="muted">{insights.past.unavailable}</p>
          ) : insights.past.items.length ? (
            list(insights.past.items, true)
          ) : (
            <p className="muted">None.</p>
          )}
        </>
      )}
    </section>
  );
}

// Text stays text. https URLs become buttons that ask the host to open them after its own checks.
function Linkified({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /https:\/\/[^\s<>"'`)\]]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const start = m.index ?? 0;
    parts.push(text.slice(last, start));
    parts.push(
      <button key={start} className="link inline" onClick={() => send({ type: 'openLink', url })}>
        {url}
      </button>,
    );
    last = start + url.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function AboutButton({ version }: { version: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button className="icon-btn" aria-label="About this app" title="About" onClick={() => dialog.current?.showModal()}>
        <Info />
      </button>
      <dialog
        ref={dialog}
        className="about"
        aria-labelledby="about-title"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="about-body">
          <div className="about-head">
            <h2 id="about-title">PagerDuty Incidents</h2>
            <button className="icon-btn" aria-label="Close" onClick={() => dialog.current?.close()}>
              <Close />
            </button>
          </div>
          <p className="mono muted">v{version}</p>
          <p>
            Made by{' '}
            <a href="https://fintonlabs.com" target="_blank" rel="noopener">
              FintonLabs
            </a>
          </p>
        </div>
      </dialog>
    </>
  );
}

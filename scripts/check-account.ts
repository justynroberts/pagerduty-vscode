// Read-only check of the extension's API client against a real PagerDuty account.
// Only GET requests. Run it yourself so the token never leaves your machine:
//   PD_TOKEN=<user API token> [PD_REGION=eu] npm run check:account

import { PagerDutyClient, PdError, Region, regionHosts } from '../src/api';
import { PAIGE_AUTHOR, isPaigeWorkflow } from '../src/model';

const token = process.env.PD_TOKEN;
if (!token) {
  console.error('Set PD_TOKEN to a PagerDuty user API token.');
  process.exit(2);
}
const region = (process.env.PD_REGION as Region) || 'us';
let user: { id: string; email: string } | undefined;
const api = new PagerDutyClient({
  apiBase: () => regionHosts(region).api,
  credentials: async () => ({ kind: 'token', accessToken: token, user }),
  refresh: async () => undefined,
});

// Account-level keys have no user: resolve PD_USER_EMAIL (or the first user) the way sign-in does.
try {
  await api.me();
} catch (e) {
  if (e instanceof PdError && e.code === 'account_level_key') {
    const email = process.env.PD_USER_EMAIL;
    const users = await api.searchUsers(email ?? '');
    const u = users.find((x) => !email || x.email.toLowerCase() === email.toLowerCase());
    if (u) user = { id: u.id, email: u.email };
    console.log(`Account-level key detected; acting as ${u ? `${u.name} <${u.email}>` : 'nobody (set PD_USER_EMAIL)'}.`);
  }
}

let failures = 0;
async function check<T>(name: string, fn: () => Promise<T>, show: (v: T) => string): Promise<T | undefined> {
  try {
    const v = await fn();
    console.log(`  ok    ${name}: ${show(v)}`);
    return v;
  } catch (e) {
    const status = e instanceof PdError ? e.status : 0;
    const gated = status === 402 || status === 403 || status === 404;
    if (!gated) failures++;
    console.log(`  ${gated ? 'gated' : 'FAIL '} ${name}: ${(e as Error).message}`);
    return undefined;
  }
}

console.log(`PagerDuty account check (${region}, read-only)\n`);
const me = await check('current user', () => api.me(), (m) => `${m.name}, role ${m.role}, ${m.teams.length} team(s)`);
const open = await check('open incidents', () => api.openIncidents(), (l) => `${l.length}`);
const recent = await check('resolved in last 7 days', () => api.resolvedSince(new Date(Date.now() - 7 * 86400_000)), (l) => `${l.length}`);
await check('on call now', () => api.oncalls(), (l) => `${l.length} entries`);
await check('priorities', () => api.priorities(), (l) => (l.length ? l.map((p) => p.name).join(', ') : 'not enabled'));

const sample = [...(open ?? []), ...(recent ?? [])].slice(0, 10);
if (!sample.length) {
  console.log('\nNo recent incidents to inspect. Trigger a test incident and run again for the detail checks.');
} else {
  const i = sample[0];
  console.log(`\nDetail checks on #${i.number} ${i.title}`);
  await check('timeline, alerts, notes', () => api.incidentDetail(i.id), (d) => `${d.log.length} log entries, ${d.alerts.length} alerts, ${d.notes.length} notes`);
  await check('escalation levels', () => api.escalationLevels(i.escalationPolicy.id), (l) => `${l.length} level(s)`);
  await check('related change events', () => api.relatedChangeEvents(i.id), (l) => `${l.length}`);
  await check('past incidents (AIOps)', () => api.pastIncidents(i.id), (l) => `${l.length}`);
  await check('related incidents (AIOps)', () => api.relatedIncidents(i.id), (l) => `${l.length}`);
  const flows = await check('manual incident workflows', () => api.manualWorkflows(i.id), (l) => (l.length ? l.map((t) => t.workflowName).join(', ') : 'none'));
  if (flows) console.log(`        Paige workflow on this service: ${flows.some(isPaigeWorkflow) ? 'yes' : 'NO (Ask Paige will show the setup hint)'}`);

  // Which authors and agents appear on recent incidents, and which the Paige matcher picks up.
  const authors = new Map<string, number>();
  for (const inc of sample) {
    const d = await api.incidentDetail(inc.id).catch(() => undefined);
    for (const n of d?.notes ?? []) authors.set(`note author: ${n.author}`, (authors.get(`note author: ${n.author}`) ?? 0) + 1);
    for (const l of d?.log ?? []) if (l.agent) authors.set(`log agent: ${l.agent}`, (authors.get(`log agent: ${l.agent}`) ?? 0) + 1);
  }
  console.log(`\nAuthors and agents on ${sample.length} recent incident(s); [paige] marks what the pane treats as Paige:`);
  for (const [k, n] of [...authors].sort((a, b) => b[1] - a[1])) console.log(`  ${PAIGE_AUTHOR.test(k.split(': ')[1]) ? '[paige]' : '       '} ${k} (${n})`);
  console.log('  If Paige posted on one of these incidents but no line is marked, update PAIGE_AUTHOR in src/model.ts.');
}

console.log(`\n${failures ? `${failures} check(s) failed.` : 'All reachable checks passed.'} "gated" means your plan or role doesn't include it; the extension shows that in the pane.`);
if (me === undefined) process.exit(1);
process.exit(failures ? 1 : 0);

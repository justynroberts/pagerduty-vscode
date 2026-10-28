// Runs inside a real VS Code extension host (see run.mjs). Drives the extension through its
// commands against the mock PagerDuty API and the real push relay.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vscode = require('vscode');

const { MOCK_URL, RELAY_URL, RELAY_TOKEN, WEBHOOK_SECRET } = process.env;

async function waitFor(what, fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const requests = async () => (await fetch(`${MOCK_URL}/__requests`)).json();

exports.run = async function () {
  const step = (name) => console.log(`  ✓ ${name}`);
  const ext = vscode.extensions.getExtension('fintonlabs.pagerduty-incidents');
  const api = await ext.activate();
  assert.ok(api, 'testing API is exported in test mode');

  await vscode.workspace.getConfiguration('pagerduty').update('apiBaseUrl', MOCK_URL, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('pagerduty').update('serviceId', 'S1', vscode.ConfigurationTarget.Global);
  assert.equal(await api.signInWithToken('test-token'), true);
  await waitFor('incidents to load', () => api.store.incidents.size === 2);
  step('signs in with a token and loads incidents');

  await waitFor('on-call for the mapped service', () => api.store.serviceOnCall?.names.includes('Ada Lovelace'));
  step('status bar on-call for the mapped service');

  const declared = ext.packageJSON.contributes.commands.map((c) => c.command);
  const registered = await vscode.commands.getCommands(true);
  assert.deepEqual(declared.filter((c) => !registered.includes(c)), []);
  step(`all ${declared.length} commands registered`);

  await vscode.commands.executeCommand('pagerduty.acknowledge', 'Q1');
  assert.equal(api.store.get('Q1').status, 'acknowledged');
  let reqs = await requests();
  const put = reqs.find((r) => r.method === 'PUT' && r.path === '/incidents/Q1');
  assert.deepEqual(put.body, { incident: { type: 'incident_reference', status: 'acknowledged' } });
  assert.equal(put.from, 'ada@example.com');
  step('acknowledge sends the right PUT with a From header');

  await vscode.commands.executeCommand('pagerduty.addNote', 'Q1', undefined, 'e2e note');
  await vscode.commands.executeCommand('pagerduty.addFollowUp', 'Q1', undefined, 'add pool alerting');
  reqs = await requests();
  const posted = reqs.filter((r) => r.method === 'POST' && r.path === '/incidents/Q1/notes').map((r) => r.body.note.content);
  assert.deepEqual(posted, ['e2e note', 'Follow-up: add pool alerting']);
  step('notes and follow-ups post to the incident');

  await vscode.commands.executeCommand('pagerduty.openIncident', 'Q1');
  const report = await waitFor('the pane to render under the webview CSP', () => api.panels.renderReports.get('Q1'), 15000);
  assert.equal(report.aboutButton, true, 'Made by FintonLabs info button rendered');
  assert.equal(report.reducedMotionRule, true, 'reduced-motion rule loaded');
  assert.ok(report.actionCount >= 7, `toolbar has the response actions (${report.actionCount})`);
  step(`incident pane renders in VS Code (${report.actionCount} actions, info button, reduced motion)`);

  const ins = await waitFor('insights', () => api.store.insights.get('Q1'), 15000);
  assert.equal(ins.paige.items.filter((t) => /paige/i.test(t.workflowName)).length, 1);
  assert.equal(ins.changes.items[0].summary, 'Deploy payments 2026.10.28-3');
  assert.match(ins.past.unavailable, /plan/i);
  assert.ok(ins.likelyFiles.items.some((f) => f.label.endsWith('src/model.ts') && f.line === 10), 'stack-trace path resolved to a workspace file');
  step('insights: Paige workflow found, change events, plan-gated AIOps, likely file from stack trace');

  await vscode.commands.executeCommand('pagerduty.copySummary', 'Q1');
  const summary = await vscode.env.clipboard.readText();
  assert.match(summary, /^#4821 Checkout latency/);
  assert.match(summary, /Latest note \(Ada Lovelace\): Follow-up: add pool alerting|Latest note/);
  step('copy summary puts a paste-ready summary on the clipboard');

  const walk = ext.packageJSON.contributes.walkthroughs?.[0];
  assert.equal(walk?.steps.length, 5);
  assert.ok(ext.packageJSON.contributes.jsonValidation?.[0].fileMatch === '.pagerduty.json');
  step('walkthrough and .pagerduty.json schema contributed');

  await vscode.commands.executeCommand('pagerduty.postmortemDraft', 'Q1');
  const doc = vscode.window.activeTextEditor?.document;
  assert.ok(doc?.getText().includes('# Postmortem: #4821'));
  assert.ok(doc.getText().includes('- [ ] add pool alerting'));
  step('postmortem draft includes follow-ups');

  await api.relay.configure(RELAY_URL, RELAY_TOKEN);
  await waitFor('relay to go live', () => api.relay.state === 'live');
  const before = (await requests()).filter((r) => r.path === '/incidents' && r.method === 'GET').length;
  const body = JSON.stringify({ event: { event_type: 'incident.resolved', data: { id: 'Q1', type: 'incident' } } });
  const sig = 'v1=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  const t0 = Date.now();
  assert.equal((await fetch(`${RELAY_URL}/webhook`, { method: 'POST', body, headers: { 'X-PagerDuty-Signature': sig } })).status, 202);
  await waitFor('a sync triggered by the relay', async () => (await requests()).filter((r) => r.path === '/incidents' && r.method === 'GET').length > before, 5000);
  step(`push relay webhook triggered a sync in ${Date.now() - t0}ms`);

  assert.ok(registered.includes('pagerduty.askPaige') && typeof vscode.chat.createChatParticipant === 'function');
  step('chat participant API available for @pagerduty');

  await vscode.commands.executeCommand('pagerduty.signOut');
  assert.equal(api.store.signedIn, false);
  step('sign out clears the session');

  // Browser sign-in: PKCE authorize → vscode:// redirect → token exchange → Bearer requests → refresh on 401.
  api.auth.appBaseOverride = MOCK_URL;
  let opened;
  api.auth.openBrowser = async (uri) => {
    opened = uri.toString(true);
    const r = await (await fetch(opened)).json(); // the "browser" approves and PagerDuty redirects back
    const back = new URL(r.redirect);
    back.searchParams.set('code', r.code);
    back.searchParams.set('state', r.state);
    setTimeout(() => api.auth.handleUri(vscode.Uri.parse(back.toString())), 50);
    return true;
  };
  const creds = await api.auth.oauth('test-client');
  assert.ok(opened.includes('code_challenge_method=S256'));
  assert.equal(creds.kind, 'oauth');
  assert.equal(creds.accessToken, 'access-1');
  assert.ok(await api.signInWithCredentials(creds));
  reqs = await requests();
  assert.equal(reqs.filter((r) => r.path === '/users/me').at(-1).auth, 'Bearer access-1');
  step('OAuth PKCE sign-in: authorize, state check, code exchange, Bearer auth');

  // A forged redirect with the wrong state must be ignored.
  api.auth.handleUri(vscode.Uri.parse(`${vscode.env.uriScheme}://fintonlabs.pagerduty-incidents/auth?code=evil&state=wrong`));
  await api.store.sync(); // let the sign-in sync finish so the next one starts after expiry
  await fetch(`${MOCK_URL}/__expire`);
  await api.store.sync();
  assert.equal(api.store.error, undefined, `sync after expiry: ${api.store.error}`);
  reqs = await requests();
  assert.ok(reqs.some((r) => r.auth === 'Bearer access-2'), 'retried with the refreshed token');
  assert.equal((await api.auth.get()).accessToken, 'access-2', 'refreshed token persisted');
  step('expired access token refreshes once and the request retries');
  await vscode.commands.executeCommand('pagerduty.signOut');
};

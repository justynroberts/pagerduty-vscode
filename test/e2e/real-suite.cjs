// Read-only run of the real extension against a live PagerDuty account (see run-real.mjs).
// Never acknowledges, resolves or writes notes.
const assert = require('node:assert/strict');
const vscode = require('vscode');

async function waitFor(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

exports.run = async function () {
  const ext = vscode.extensions.getExtension('fintonlabs.pagerduty-incidents');
  const api = await ext.activate();
  const user = process.env.PD_USER_ID ? { id: process.env.PD_USER_ID, email: process.env.PD_USER_EMAIL } : undefined;
  assert.equal(await api.signInWithToken(process.env.PD_TOKEN, user), true, 'sign-in');
  await waitFor('first sync', () => api.store.lastSync);
  assert.equal(api.store.error, undefined, `sync error: ${api.store.error}`);
  const all = [...api.store.incidents.values()];
  console.log(`  ✓ signed in as ${api.store.me.name} (${api.store.me.role}); ${all.length} open incident(s), ${api.store.oncalls.length} on-call entries`);

  const target = all[0];
  if (!target) {
    console.log('  - no open incidents; skipping pane checks');
    return;
  }
  await vscode.commands.executeCommand('pagerduty.openIncident', target.id);
  const report = await waitFor('pane render', () => api.panels.renderReports.get(target.id));
  assert.ok(report.aboutButton && report.reducedMotionRule);
  const detail = await waitFor('detail', () => api.store.details.get(target.id));
  console.log(`  ✓ pane rendered #${target.number} "${target.title}": ${detail.log.length} log entries, ${detail.alerts.length} alerts, ${detail.notes.length} notes, ${report.actionCount} actions`);
  const ins = await waitFor('insights', () => api.store.insights.get(target.id), 30000);
  const slot = (s) => (s.unavailable ? `unavailable (${s.unavailable})` : `${s.items.length}`);
  console.log(`  ✓ insights: changes ${slot(ins.changes)}, past ${slot(ins.past)}, related ${slot(ins.related)}, workflows ${slot(ins.paige)}, likely files ${slot(ins.likelyFiles)}, commits ${slot(ins.commits)}`);
};

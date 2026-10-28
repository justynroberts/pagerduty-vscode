import { describe, expect, it, vi } from 'vitest';
import { PagerDutyClient } from '../src/api';
import { extractPaths, isPaigeWorkflow, normaliseChangeEvent, normaliseTrigger, parseMapping } from '../src/model';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(responses: Response[]) {
  const fetch = vi.fn(async () => responses.shift()!);
  const c = new PagerDutyClient({ apiBase: () => 'https://api.test', credentials: async () => ({ kind: 'token', accessToken: 't' }), refresh: vi.fn(), fetch, sleep: async () => {} });
  const call = (n = 0) => {
    const [url, init] = fetch.mock.calls[n] as unknown as [string, RequestInit];
    return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
  };
  return { c, call };
}

describe('extractPaths', () => {
  it('finds paths and line numbers in stack traces', () => {
    const trace = `TypeError: x is undefined
    at charge (/app/src/payments/charge.ts:42:13)
    File "services/billing/worker.py", line 88, in run
    at Object.<anonymous> (node_modules/express/lib/router.js:10:1)
    see https://example.com/app.js`;
    expect(extractPaths(trace)).toEqual([
      { path: 'app/src/payments/charge.ts', line: 42 },
      { path: 'services/billing/worker.py', line: 88 },
    ]);
  });
});

describe('insight normalisers', () => {
  it('maps change events and keeps only real links', () => {
    const e = normaliseChangeEvent({ id: 'C1', summary: 'Deploy 912', timestamp: 't', source: 'github', links: [{ href: 'https://x', text: '' }, { text: 'no href' }], correlation_reason: { reason: 'most_recent' } });
    expect(e).toEqual({ id: 'C1', summary: 'Deploy 912', timestamp: 't', source: 'github', reason: 'most_recent', links: [{ href: 'https://x', text: 'https://x' }] });
  });
  it('spots Paige workflows by name', () => {
    expect(isPaigeWorkflow(normaliseTrigger({ id: 'T', workflow: { id: 'W', name: 'Paige virtual responder' } }))).toBe(true);
    expect(isPaigeWorkflow(normaliseTrigger({ id: 'T', workflow: { id: 'W', name: 'Page the DBA' } }))).toBe(false);
  });
  it('accepts mapping paths and rejects bad ones', () => {
    expect(parseMapping('{"serviceId":"PABC123","paths":["services/payments/**"]}').mapping?.paths).toEqual(['services/payments/**']);
    expect(parseMapping('{"serviceId":"PABC123","paths":"x"}').error).toMatch(/paths/);
  });
});

describe('response request bodies', () => {
  it('starts a workflow on the incident', async () => {
    const { c, call } = client([json(201, {})]);
    await c.startWorkflow('W1', 'Q1');
    expect(call()).toMatchObject({
      url: 'https://api.test/incident_workflows/W1/instances',
      method: 'POST',
      body: { incident_workflow_instance: { incident: { id: 'Q1', type: 'incident_reference' } } },
    });
  });
  it('lists manual workflows for the incident', async () => {
    const { c, call } = client([json(200, { triggers: [{ id: 'T1', workflow: { id: 'W1', name: 'Paige virtual responder' } }] })]);
    expect(await c.manualWorkflows('Q1')).toEqual([{ triggerId: 'T1', workflowId: 'W1', workflowName: 'Paige virtual responder' }]);
    expect(call().url).toContain('incident_id=Q1&trigger_type=manual');
  });
  it('merges sources into the target', async () => {
    const { c, call } = client([json(200, { incident: { id: 'Q1' } })]);
    await c.merge('Q1', ['Q2', 'Q3']);
    expect(call()).toMatchObject({ url: 'https://api.test/incidents/Q1/merge', method: 'PUT', body: { source_incidents: [{ id: 'Q2', type: 'incident_reference' }, { id: 'Q3', type: 'incident_reference' }] } });
  });
  it('requests responders with typed targets', async () => {
    const { c, call } = client([json(200, {})]);
    await c.requestResponders('Q1', 'PU1', 'help', [{ id: 'PU2', type: 'user' }]);
    expect(call().body).toEqual({ requester_id: 'PU1', message: 'help', responder_request_targets: [{ responder_request_target: { id: 'PU2', type: 'user_reference' } }] });
  });
  it('reports a plan limit on 402', async () => {
    const { c } = client([json(402, { error: { message: 'Upgrade' } })]);
    await expect(c.pastIncidents('Q1')).rejects.toMatchObject({ status: 402 });
  });
});

describe('security guards', async () => {
  const { isSafeRelayUrl, isCommitHash } = await import('../src/model');
  it('passes only real commit hashes to git', () => {
    expect(isCommitHash('a1b2c3d')).toBe(true);
    expect(isCommitHash('--output=/tmp/x')).toBe(false);
    expect(isCommitHash('a1b2c3d~1')).toBe(false);
    expect(isCommitHash('HEAD')).toBe(false);
  });
  it('only sends the relay token over https or to loopback', () => {
    expect(isSafeRelayUrl('https://relay.example.com')).toBe(true);
    expect(isSafeRelayUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isSafeRelayUrl('http://relay.example.com')).toBe(false);
    expect(isSafeRelayUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeRelayUrl('not a url')).toBe(false);
  });
});

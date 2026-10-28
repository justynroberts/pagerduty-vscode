import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelay, toRelayEvent, verifySignature } from '../relay/server.mjs';

const sign = (body: string, secret: string) => 'v1=' + createHmac('sha256', secret).update(body).digest('hex');

describe('relay signature', () => {
  it('accepts a matching v1 signature among several', () => {
    const body = '{"a":1}';
    expect(verifySignature(body, `v1=deadbeef, ${sign(body, 's3cret')}`, 's3cret')).toBe(true);
    expect(verifySignature(body, sign(body, 'other'), 's3cret')).toBe(false);
    expect(verifySignature(body, undefined, 's3cret')).toBe(false);
  });
  it('forwards only type and incident id', () => {
    expect(toRelayEvent({ event: { event_type: 'incident.acknowledged', occurred_at: 't', data: { id: 'Q1', type: 'incident', title: 'secret stuff' } } })).toEqual({
      type: 'incident.acknowledged',
      incidentId: 'Q1',
      at: 't',
    });
    expect(toRelayEvent({ event: { event_type: 'incident.annotated', data: { type: 'incident_note', incident: { id: 'Q2' } } } })?.incidentId).toBe('Q2');
    expect(toRelayEvent({})).toBeNull();
  });
});

describe('relay server', () => {
  const relay = createRelay({ webhookSecret: 'whsec', clientToken: 'tok', log: () => {} });
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    for (const c of relay.clients) c.end();
    relay.server.close();
  });

  it('rejects editors without the token and unsigned webhooks', async () => {
    expect((await fetch(`${base}/events`)).status).toBe(401);
    expect((await fetch(`${base}/webhook`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('streams a signed webhook to a connected editor', async () => {
    const res = await fetch(`${base}/events`, { headers: { Authorization: 'Bearer tok' } });
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    const body = JSON.stringify({ event: { event_type: 'incident.triggered', data: { id: 'Q9', type: 'incident' } } });
    const post = await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'X-PagerDuty-Signature': sign(body, 'whsec') } });
    expect(post.status).toBe(202);
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"incidentId":"Q9"');
    await reader.cancel();
  });
});

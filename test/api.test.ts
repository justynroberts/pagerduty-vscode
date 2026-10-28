import { describe, expect, it, vi } from 'vitest';
import { Credentials, PagerDutyClient, PdError, encodeQuery } from '../src/api';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(responses: Response[], creds: Credentials = { kind: 'token', accessToken: 'tok' }, refresh = vi.fn()) {
  const fetch = vi.fn(async () => responses.shift()!);
  const sleep = vi.fn(async () => {});
  const c = new PagerDutyClient({ apiBase: () => 'https://api.test', credentials: async () => creds, refresh, fetch, sleep, fromEmail: () => 'ada@example.com' });
  return { c, fetch, sleep, refresh };
}

describe('PagerDutyClient', () => {
  it('sends v2 headers and token auth', async () => {
    const { c, fetch } = client([json(200, { user: { id: 'PU1', name: 'Ada', role: 'user', teams: [] } })]);
    await c.me();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/users/me?include%5B%5D=teams');
    expect(init.headers).toMatchObject({ Accept: 'application/vnd.pagerduty+json;version=2', Authorization: 'Token token=tok' });
  });

  it('uses Bearer for OAuth and a From header on writes', async () => {
    const { c, fetch } = client([json(200, { incident: { id: 'Q1', status: 'acknowledged' } })], { kind: 'oauth', accessToken: 'abc' });
    await c.setStatus('Q1', 'acknowledged');
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer abc', From: 'ada@example.com' });
    expect(JSON.parse(init.body as string)).toEqual({ incident: { type: 'incident_reference', status: 'acknowledged' } });
  });

  it('backs off on 429 using Retry-After', async () => {
    const { c, sleep } = client([json(429, {}, { 'retry-after': '2' }), json(200, { notes: [] })]);
    await c.request('GET', '/x');
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('refreshes once on 401 for OAuth, then retries', async () => {
    const refresh = vi.fn(async () => ({ kind: 'oauth' as const, accessToken: 'new' }));
    const { c, fetch } = client([json(401, {}), json(200, { ok: true })], { kind: 'oauth', accessToken: 'old', refreshToken: 'r' }, refresh);
    await c.request('GET', '/x');
    expect(refresh).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer new' });
  });

  it('turns 403 into a permission error', async () => {
    const { c } = client([json(403, { error: { message: 'Forbidden' } })]);
    const err = (await c.request('PUT', '/x').catch((e: unknown) => e)) as PdError;
    expect(err).toBeInstanceOf(PdError);
    expect(err.isPermission).toBe(true);
  });

  it('follows paging', async () => {
    const { c } = client([json(200, { incidents: [{ id: 1 }], more: true }), json(200, { incidents: [{ id: 2 }], more: false })]);
    expect(await c.paged('/incidents', 'incidents')).toHaveLength(2);
  });

  it('encodes array params with brackets', () => {
    expect(encodeQuery({ 'statuses[]': ['triggered', 'acknowledged'], skip: undefined })).toBe('?statuses%5B%5D=triggered&statuses%5B%5D=acknowledged');
  });
});

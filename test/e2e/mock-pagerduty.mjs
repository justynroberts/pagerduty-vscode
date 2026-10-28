// A small stand-in for the PagerDuty REST API, with enough fixture data to drive every surface.
// GET /__requests returns what the extension called, so the test can assert on real traffic.
import { createHash } from 'node:crypto';
import http from 'node:http';

export function createMockPagerDuty() {
  const requests = [];
  const now = Date.now();
  const ago = (m) => new Date(now - m * 60000).toISOString();
  const ref = (id, summary, type) => ({ id, summary, type });
  const incidents = {
    Q1: {
      id: 'Q1', incident_number: 4821, title: 'Checkout latency p99 over 2s', status: 'triggered', urgency: 'high',
      created_at: ago(14), updated_at: ago(2), html_url: 'https://acme.pagerduty.com/incidents/Q1',
      service: ref('S1', 'Payments API', 'service_reference'), escalation_policy: ref('E1', 'Payments', 'escalation_policy_reference'),
      assignments: [{ assignee: ref('PU1', 'Ada Lovelace', 'user_reference') }], acknowledgements: [], teams: [ref('PT1', 'Payments', 'team_reference')], priority: { summary: 'P1' },
    },
    Q2: {
      id: 'Q2', incident_number: 4822, title: 'Disk 90% on db-2', status: 'acknowledged', urgency: 'low',
      created_at: ago(60), updated_at: ago(30), html_url: 'https://acme.pagerduty.com/incidents/Q2',
      service: ref('S2', 'Database', 'service_reference'), escalation_policy: ref('E2', 'DBA', 'escalation_policy_reference'),
      assignments: [{ assignee: ref('PU2', 'Grace Hopper', 'user_reference') }], acknowledgements: [], teams: [], priority: null,
    },
  };
  const notes = { Q1: [{ id: 'N1', content: 'Looking at the pool', created_at: ago(5), user: ref('PU1', 'Ada Lovelace') }] };

  // OAuth: codes remember their PKCE challenge; tokens are tracked so refresh can be exercised.
  const oauth = { codes: new Map(), valid: new Set(), expireNext: false, refreshed: 0 };

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined; // form-encoded OAuth token requests are read from `raw`
      }
      if (url.pathname === '/__requests') return send(res, 200, requests);
      requests.push({ method: req.method, path: url.pathname, query: url.search, body, auth: req.headers.authorization, from: req.headers.from });
      if (url.pathname === '/oauth/authorize') {
        const q = url.searchParams;
        if (q.get('client_id') !== 'test-client' || q.get('code_challenge_method') !== 'S256' || !q.get('state')) return send(res, 400, { error: 'bad authorize request' });
        const code = `code-${Date.now()}`;
        oauth.codes.set(code, { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') });
        return send(res, 200, { code, state: q.get('state'), redirect: q.get('redirect_uri') });
      }
      if (url.pathname === '/oauth/token') {
        const f = new URLSearchParams(raw);
        if (f.get('grant_type') === 'authorization_code') {
          const c = oauth.codes.get(f.get('code'));
          const verifierHash = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
          if (!c || c.challenge !== verifierHash || c.redirect !== f.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant' });
          oauth.codes.delete(f.get('code'));
          oauth.valid.add('access-1');
          return send(res, 200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
        }
        if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'refresh-1') {
          oauth.refreshed++;
          oauth.valid.add('access-2');
          return send(res, 200, { access_token: 'access-2', expires_in: 3600 });
        }
        return send(res, 400, { error: 'invalid_grant' });
      }
      if (url.pathname === '/__expire') {
        oauth.valid.delete('access-1');
        return send(res, 200, {});
      }
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const authed = req.headers.authorization === 'Token token=test-token' || (bearer && oauth.valid.has(bearer));
      if (!authed) return send(res, 401, { error: { message: 'bad token' } });
      const p = url.pathname;
      let m;
      if (p === '/users/me') return send(res, 200, { user: { id: 'PU1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'user', teams: [ref('PT1', 'Payments')] } });
      if (p === '/incidents' && req.method === 'GET') {
        const statuses = url.searchParams.getAll('statuses[]');
        return send(res, 200, { incidents: Object.values(incidents).filter((i) => statuses.includes(i.status)), more: false });
      }
      if ((m = /^\/incidents\/(Q\d)$/.exec(p))) {
        const inc = incidents[m[1]];
        if (req.method === 'PUT') Object.assign(inc, body.incident, { updated_at: new Date().toISOString() });
        return send(res, 200, { incident: inc });
      }
      if ((m = /^\/incidents\/(Q\d)\/(\w+)$/.exec(p))) {
        const [, id, sub] = m;
        if (sub === 'log_entries') {
          return send(res, 200, { log_entries: [
            { id: 'L2', type: 'notify_log_entry', summary: 'Notified Ada Lovelace', created_at: ago(13) },
            { id: 'L1', type: 'trigger_log_entry', summary: 'Triggered through the API', created_at: ago(14), agent: { summary: 'Datadog' } },
          ], more: false });
        }
        if (sub === 'alerts') {
          return send(res, 200, { alerts: [{ id: 'A1', summary: 'p99 > 2s', status: 'triggered', severity: 'critical', created_at: ago(14),
            body: { details: { stack: 'Error: timeout\n    at selectIncidents (src/model.ts:10:5)' } } }], more: false });
        }
        if (sub === 'notes' && req.method === 'POST') {
          (notes[id] ??= []).push({ id: `N${Date.now()}`, content: body.note.content, created_at: new Date().toISOString(), user: ref('PU1', 'Ada Lovelace') });
          return send(res, 201, { note: {} });
        }
        if (sub === 'notes') return send(res, 200, { notes: notes[id] ?? [] });
        if (sub === 'related_change_events') return send(res, 200, { change_events: [{ id: 'C1', summary: 'Deploy payments 2026.10.28-3', timestamp: ago(30), source: 'GitHub', links: [], correlation_reason: { reason: 'most_recent' } }] });
        if (sub === 'past_incidents' || sub === 'related_incidents') return send(res, 402, { error: { message: 'Event Intelligence required' } });
        if (sub === 'outlier_incident') return send(res, 404, { error: { message: 'Not found' } });
      }
      if (p === '/incident_workflows/triggers') {
        return send(res, 200, { triggers: [{ id: 'T1', workflow: { id: 'W1', name: 'Paige virtual responder' } }, { id: 'T2', workflow: { id: 'W2', name: 'Open Zoom bridge' } }], more: false });
      }
      if (p === '/oncalls') return send(res, 200, { oncalls: [{ user: ref('PU1', 'Ada Lovelace'), escalation_policy: ref('E1', 'Payments'), escalation_level: 1 }], more: false });
      if (p === '/services/S1') return send(res, 200, { service: { id: 'S1', escalation_policy: { id: 'E1' } } });
      send(res, 404, { error: { message: `no mock for ${req.method} ${p}` } });
    });
  });
  return { server, requests };
}

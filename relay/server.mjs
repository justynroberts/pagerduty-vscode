// PagerDuty push relay: receives PagerDuty v3 webhooks and fans them out to signed-in editors
// over Server-Sent Events. Only the event type and incident ID are forwarded, never incident
// content: the extension re-reads details through its own authenticated API client.
// No dependencies. Config: WEBHOOK_SECRET, RELAY_TOKEN, PORT (default 8787).

import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 1024 * 1024;
const HEARTBEAT_MS = 25_000;

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// X-PagerDuty-Signature carries one or more comma-separated "v1=<hex hmac-sha256>" values.
export function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = 'v1=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return header.split(',').some((sig) => safeEqual(sig.trim(), expected));
}

export function toRelayEvent(body) {
  const e = body?.event;
  if (!e?.event_type) return null;
  const data = e.data ?? {};
  const incidentId = data.type === 'incident' ? data.id : data.incident?.id;
  return { type: e.event_type, incidentId: incidentId ?? null, at: e.occurred_at ?? new Date().toISOString() };
}

export function createRelay({ webhookSecret, clientToken, log = console.log }) {
  if (!webhookSecret || !clientToken) throw new Error('WEBHOOK_SECRET and RELAY_TOKEN are required');
  const clients = new Set();

  const broadcast = (evt) => {
    const frame = `event: pagerduty\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of clients) res.write(frame);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, clients: clients.size }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const auth = req.headers.authorization ?? '';
      if (!safeEqual(auth, `Bearer ${clientToken}`)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      req.on('close', () => {
        clearInterval(beat);
        clients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (!verifySignature(raw, req.headers['x-pagerduty-signature'], webhookSecret)) {
          log('rejected webhook: bad signature');
          res.writeHead(401).end();
          return;
        }
        let evt = null;
        try {
          evt = toRelayEvent(JSON.parse(raw.toString('utf8')));
        } catch {
          // Malformed JSON is acknowledged and ignored so PagerDuty doesn't retry it.
        }
        if (evt) broadcast(evt);
        res.writeHead(202).end();
      });
      return;
    }

    res.writeHead(404).end();
  });

  return { server, clients, broadcast };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8787);
  const { server } = createRelay({ webhookSecret: process.env.WEBHOOK_SECRET, clientToken: process.env.RELAY_TOKEN });
  server.listen(port, () => console.log(`pagerduty-relay listening on :${port}`));
}

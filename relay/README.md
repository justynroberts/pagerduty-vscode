# PagerDuty push relay

Optional. Without it the extension polls every 30 seconds. With it, editors refresh within a second of a change in PagerDuty.

An extension can't receive webhooks, so this small service receives them and streams them to editors over Server-Sent Events. It forwards only the event type and incident ID, never incident content. Each editor re-reads details with its own PagerDuty credentials and permissions.

## Run

```bash
export WEBHOOK_SECRET=...   # from the PagerDuty webhook subscription
export RELAY_TOKEN=$(openssl rand -hex 32)
docker compose up -d        # or: node server.mjs
```

Put it behind HTTPS, for example a Coolify app or any TLS-terminating proxy.

## Wire up

1. In PagerDuty: **Integrations → Generic Webhooks (v3) → New Webhook**. Point it at `https://<relay>/webhook`, scope it to the account or your services, subscribe to the incident events, then copy the signing secret into `WEBHOOK_SECRET`.
2. In VS Code: run **PagerDuty: Connect Push Relay**, then enter `https://<relay>` and the `RELAY_TOKEN`.

The status bar shows a broadcast icon while the stream is live. If the relay drops, the extension falls back to polling and reconnects with backoff.

## Endpoints

| | |
|---|---|
| `POST /webhook` | PagerDuty webhooks. Checks `X-PagerDuty-Signature` (HMAC-SHA256) |
| `GET /events` | SSE stream for editors. Needs `Authorization: Bearer <RELAY_TOKEN>` |
| `GET /healthz` | Liveness and connected-client count |

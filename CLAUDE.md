# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`fintonlabs.pagerduty-incidents`) that covers the whole PagerDuty incident lifecycle inside the editor: triage, respond, Paige and AIOps insights, and the code behind an incident. The aim is to reduce context switching. When choosing scope, prefer more in-editor functionality over less. The PRD and design doc were pasted into the session that created the repo; the PRD's non-goals still apply (no schedule editing, service config, analytics or status page admin).

## Commands

```bash
npm run build          # esbuild: dist/extension.js (Node CJS) + dist/webview/main.{js,css} (browser IIFE)
npm run watch
npm run typecheck      # tsc --noEmit over src/, webview/, test/
npm test               # vitest run
npx vitest run test/api.test.ts -t "backs off"   # single file / single test
npm run test:e2e       # real VS Code (local install or downloaded) + test/e2e/mock-pagerduty.mjs + relay
PD_TOKEN=… npm run check:account   # read-only API client checks against a live account; lists note authors for PAIGE_AUTHOR
PD_TOKEN=… npm run test:real       # read-only run of the extension in real VS Code against a live account
npm run package        # typecheck + test + clean production build + .vsix
npm run publish:marketplace / publish:openvsx    # need VSCE_PAT / OVSX_PAT
```

F5 (`.vscode/launch.json`) builds and opens an Extension Development Host. `vsce` runs with `--no-dependencies --allow-missing-repository`. Everything is bundled, so the `.vsix` has no `node_modules`. Keep it that way: runtime deps go into the bundle, never `dependencies`.

## Architecture

The extension host owns all state and every network call. The surfaces only render and send intents.

- `src/api.ts` is the **only** module that talks to PagerDuty: v2 REST, 429 backoff via Retry-After, one OAuth refresh on 401, `From` header on writes, 402/403 mapped to readable `PdError`s. It doesn't import `vscode`, so it's unit-tested with a stubbed `fetch`.
- `src/model.ts` holds normalised types, normalisers from raw API JSON, sorting/filtering, `.pagerduty.json` validation and stack-trace path extraction. It has no `vscode` import and is shared with the webview (type imports plus a few pure helpers).
- `src/store.ts` runs a single poll loop for every view and panel (30s focused, 2 min unfocused). It does optimistic `setStatus` with rollback, and `mutate()` for every other write (pending → API → audit → re-read detail). `loadDetail`/`loadInsights` fill per-incident caches. `watch(id)` marks incidents with an open pane so they keep refreshing after they leave the list. Open incidents persist to `globalState` for a warm cold start.
- `src/views.ts` has the tree views, the status bar and the incident tree item. Commands receive `IncidentItem`, an id string, or nothing; `extension.ts#idsFrom` / the `target` resolver fall back to the active pane, then a QuickPick.
- `src/extension.ts` wires everything together and registers sign-in, list, ack/resolve and filter commands. `src/respond.ts` registers every other incident action, including Ask Paige, Ask Agent and Incident Actions…
- `src/panel.ts` + `webview/` is the incident pane. It uses a typed protocol in `src/protocol.ts`. `PANE_ACTIONS` maps pane buttons 1:1 to `pagerduty.<action>` commands, so the pane, palette and tree menus share one code path. Adding a pane action means adding it to `PANE_ACTIONS` and registering the command.
- `src/codeContext.ts` uses the built-in Git extension API (`vscode.git` v1) for commits in the window before the trigger, diffs, and likely files. Off in untrusted workspaces.
- `src/mcp.ts` registers PagerDuty's remote MCP server through `vscode.lm.registerMcpServerDefinitionProvider`, accessed dynamically so older VS Code and forks still load. The token is attached only in `resolveMcpServerDefinition`.
- `src/chat.ts` is the `@pagerduty` chat participant (and voice, through VS Code Speech). `model.ts#parseChatIntent` maps slash commands or dictated sentences to intents. Writes are only offered as buttons that run the normal commands, never executed directly from chat text.
- `src/relay.ts` + `relay/server.mjs`: an optional push relay. The relay verifies `X-PagerDuty-Signature` and forwards only `{type, incidentId}` over SSE. The client debounces events into `store.sync()`, and `store.setLive` relaxes polling while connected. The relay has no dependencies and ships as a container (`relay/Dockerfile`, container name `pagerduty-relay`).
- Follow-ups are notes prefixed `Follow-up:` (`model.ts#FOLLOW_UP_PREFIX`). `buildPostmortem` is a pure Markdown builder.
- Test mode: `activate()` returns a `TestingApi` (store, panels, relay, `signInWithToken`) only when `extensionMode === Test`. Panes then send a `rendered` report (info button, reduced-motion rule, action count) so the e2e can prove the webview rendered under the real CSP. `pagerduty.apiBaseUrl` (application scope, https or loopback http) points the client at the mock. When you add an API call, add a mock route in `test/e2e/mock-pagerduty.mjs`.
- Account-level API keys: `/users/me` returns 400, and `api.ts` turns that into `PdError.code === 'account_level_key'`. Sign-in then asks for the user's email (`chooseActingUser`) and stores `Credentials.user`. `me()` reads `/users/{id}`, and writes send that email as `From`. Verified against a live account on 2026-10-28.
- `src/auth.ts`: user API token by default. OAuth PKCE is offered only when a client ID is set (`BUNDLED_CLIENT_ID` or `pagerduty.oauthClientId`). It uses Classic User OAuth at `identity.pagerduty.com/oauth/*` (one host for all regions) with PKCE and `scope=write`, as PagerDuty documents for public clients. Scoped OAuth needs a client secret, so it can't be used. Access tokens last 30 days, and refresh may need a secret, so a failed refresh signs the user out with a prompt to sign in again. The full flow (PKCE, state check, code exchange, Bearer auth, refresh on 401) is covered by `npm run test:e2e` against a mock OAuth server via the `appBaseOverride`/`openBrowser` test seams; the endpoints and scope match PagerDuty's OAuth docs (checked 2026-10-28) but haven't been exercised with a real registered app. The redirect goes through `asExternalUri` for remote windows.

## Paige: what's real

PagerDuty has no public REST API for chatting with Paige or reading its findings. Ask Paige starts the service's manually triggered incident workflow whose name matches `/paige|sre agent/i`, via `GET /incident_workflows/triggers?incident_id=&trigger_type=manual` then `POST /incident_workflows/{id}/instances`. The pane shows notes and log entries whose author or agent matches `PAIGE_AUTHOR` in `src/model.ts`. Matching by author name is a heuristic. `npm run check:account` lists the real authors and agents on recent incidents. The live test account had no Paige workflow or Paige-authored entries, and no PagerDuty AI entitlement (no Paige action in `GET /incident_workflows/actions`, no AI ability in `GET /abilities`), so the match is still unconfirmed. Confirm it on an account with PagerDuty AI. Past, related and outlier incidents need the AIOps / Event Intelligence plan; `store.ts#slot` turns 402/403/404 into an `unavailable` message rather than an error.

## Rules that are easy to break

- Credentials live in SecretStorage only. Never in settings, globalState, logs or webview messages.
- Incident content is untrusted. The pane renders text only (React escaping, no `dangerouslySetInnerHTML`). Links go to the host as `openLink` and pass `openUntrustedLink` (https only, non-pagerduty.com hosts ask first). `openFile` only opens paths inside the workspace. The webview CSP is nonce-only: no inline script, no remote content.
- Writes that affect other people (resolve, reassign, escalate, merge, urgency, priority, snooze, responders, status updates, workflows) get one modal confirm stating exactly what changes, and an audit entry through `store.mutate`/`setStatus`.
- Settings that could redirect credentials (`apiBaseUrl`, `relayUrl`, `oauthClientId`) are `"scope": "application"`, so a cloned repo's workspace settings can't override them.
- Read-only roles (`model.ts#canWrite`) and untrusted workspaces disable writes via the `pagerduty.canWrite` context key and `access()`.

## Look and feel

See `DESIGN.md`. This project deliberately ships light and dark themes and inherits the editor font. Both break the house `distinctive-ui` defaults, at the user's request, to match PagerDuty. Pane surfaces come from `--vscode-*` variables; PagerDuty colours only carry accents. State always pairs colour with a shape and a text label. The "Made by FintonLabs" info button sits at the end of the pane header, and *PagerDuty: About* is in the views' overflow menu.

To check the pane visually without VS Code, load `dist/webview/main.{js,css}` in a page that stubs `acquireVsCodeApi` and posts a `{type:'state', state}` message, then screenshot it with headless Chrome.

# PagerDuty Incidents for VS Code

Work PagerDuty incidents without leaving the editor. See what's assigned to you, read the timeline, alerts and notes, and acknowledge or resolve, all from VS Code.

## Install

From a release `.vsix`:

```bash
code --install-extension pagerduty-incidents-0.1.0.vsix
```

Or in VS Code: Extensions view → `…` menu → **Install from VSIX…**. Cursor, VSCodium and other forks install the same file.

## Sign in

Click the PagerDuty icon in the activity bar, then **Sign In**.

- **User API token** (works on every account): in PagerDuty open *My Profile → User Settings → Create API User Token*, then paste it. The token is stored in VS Code's secret storage, never in settings.
- **Account-level API key** (an admin's general key): paste it the same way. The extension then asks for your PagerDuty login email, so that actions are recorded as you.
- **Browser sign-in (OAuth)**: offered when an OAuth client ID is configured (`pagerduty.oauthClientId`, or bundled in a release build). One browser round trip, then back to VS Code.

EU accounts: set `pagerduty.region` to `eu` before signing in.

## What you get

**Triage.** *My Incidents*, *My Teams* and *All Incidents* views with search and status, urgency and service filters. Triggered incidents assigned to you show as a badge. *On Call Now* lists level-1 on-call per escalation policy. The status bar shows your open count and who is on call for this repo's service. New incidents assigned to you raise a notification with an **Acknowledge** button.

**Respond.** The incident pane opens as an editor tab beside your code. It has every action: acknowledge, resolve, reassign (user or escalation policy), escalate to a level, add responders, snooze, post a status update, change urgency or priority, merge (with a preview), and run any manually triggered incident workflow. Add notes inline with Ctrl/Cmd+Enter. *PagerDuty: Incident Actions…* puts every action for an incident in one keyboard-driven list, and every action is also its own `PagerDuty:` command you can bind. Nothing is bound by default.

**Paige and AI.**
- **Ask Paige to investigate** starts the *Paige virtual responder* incident workflow on the incident. Paige's findings and next steps show at the top of the pane as they land. PagerDuty has no public API to chat with Paige directly, so this needs that workflow set up on the service with a manual trigger. The pane tells you if it's missing.
- **Ask editor agent** opens your editor's agent chat with an investigation prompt. The extension registers PagerDuty's official MCP server (`https://mcp.pagerduty.com/mcp`) with the same sign-in, so the agent can read and act on PagerDuty with your permissions. Turn it off with `pagerduty.agentTools`.
- **Insights**: related incidents happening now, similar past incidents (with a similarity score) and outlier detection, from PagerDuty AIOps. On plans without AIOps the pane says so instead of failing.

**Code context.**
- PagerDuty change events correlated with the incident (deploys, PRs)
- Commits in the open workspace from the hours before the trigger time (`pagerduty.changeWindowHours`, default 24). Click a commit to open its diff.
- **Likely files**: paths in stack traces and alert payloads that resolve to workspace files, plus files touched by those commits. One click opens the file at the line. These are suggestions, not verdicts.

**Learn.** Add follow-ups from the pane. They're saved on the incident as notes starting `Follow-up:`. **Postmortem Draft** opens an editable Markdown postmortem built from the impact numbers, timeline, notes, changes, likely files, similar incidents and follow-ups.

**Chat and voice.** Type `@pagerduty` in the editor's chat: `/mine`, `/summary 4821`, `/ack 4821`, `/resolve 4821`, `/note 4821 rolled back`, `/paige 4821`, or just ask a question. It answers from the incident data with the editor's language model. Actions come back as buttons that run the same commands, so they get the same confirms. With the [VS Code Speech](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-speech) extension you can say it instead, for example "@pagerduty acknowledge 4821".

**Live updates (optional).** Polling every 30 seconds works with no setup. For near-instant updates, run the small push relay from the `relay/` folder of the source repo (one container) and connect it with *PagerDuty: Connect Push Relay*.

**Safe by default.** Anything that affects other people asks once and shows exactly what changes. Read-only roles and untrusted workspaces get a read-only view. *PagerDuty: Show Audit Log* lists every write made from VS Code.

## Link a repo to a service

Add `.pagerduty.json` at the repo root so the status bar shows who is on call for it:

```json
{
  "serviceId": "PXXXXXX",
  "paths": ["services/payments/**"]
}
```

The ID is the last part of the service's URL in PagerDuty. `paths` is optional and scopes the commit list and likely files to that part of a monorepo. Without the file, set `pagerduty.serviceId` instead, or skip it: everything else works without a mapping.

## Settings

| Setting | Default | |
|---|---|---|
| `pagerduty.region` | `us` | `us` or `eu` |
| `pagerduty.serviceId` | | Fallback service for the status bar |
| `pagerduty.pollIntervalSeconds` | `30` | Poll rate while focused (unfocused: 2 min) |
| `pagerduty.notifications` | `true` | Toasts for new incidents assigned to you |
| `pagerduty.theme` | `auto` | Incident pane theme: `auto`, `light`, `dark` |
| `pagerduty.oauthClientId` | | PagerDuty OAuth app client ID (PKCE) |
| `pagerduty.changeWindowHours` | `24` | How far before the trigger to look for commits |
| `pagerduty.agentTools` | `true` | Register PagerDuty's MCP server with the editor's agent chat |
| `pagerduty.relayUrl` | | Push relay URL (set with *Connect Push Relay*) |
| `pagerduty.apiBaseUrl` | | REST API override for a proxy (https, user settings only) |

## Develop

```bash
npm install
npm run build        # bundle host + webview into dist/
npm test             # vitest
npm run typecheck
npm run test:e2e     # real VS Code + mock PagerDuty API + push relay

# Read-only checks against a live account (token stays on your machine)
PD_TOKEN=... [PD_USER_EMAIL=...] npm run check:account   # API client only
PD_TOKEN=... [PD_USER_EMAIL=...] npm run test:real       # the extension in real VS Code
```

Press F5 in VS Code to launch an Extension Development Host.

## Release

```bash
npm run package                 # typecheck, test, production build, .vsix
npm run publish:marketplace     # needs VSCE_PAT
npm run publish:openvsx         # needs OVSX_PAT
```

The `.vsix` bundles everything, with no runtime `node_modules`.

---

MIT · Made by [FintonLabs](https://fintonlabs.com). Not affiliated with or endorsed by PagerDuty, Inc.

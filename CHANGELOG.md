# Changelog

## 0.1.0

- Sign in with a user API token, an account-level API key (pick your user) or OAuth (PKCE), stored in SecretStorage
- My Incidents, My Teams, All Incidents and On Call Now views with search and filters
- Incident pane with timeline, responders, notes and alerts
- Acknowledge and resolve with optimistic updates, rollback and a local audit log
- Status bar count and on-call for the mapped service (`.pagerduty.json`)
- Notifications for new incidents assigned to you
- Reassign, escalate, add responders, snooze, status updates, urgency, priority, merge with preview, incident workflows
- Inline notes, and an Incident Actions… list for keyboard use
- Ask Paige (Paige virtual responder workflow), with Paige findings surfaced in the pane
- PagerDuty MCP server registered for the editor's agent chat, plus Ask Editor Agent
- AIOps insights: related, past and outlier incidents
- Code context: correlated change events, workspace commits before the trigger, likely files and diffs
- Follow-ups and Postmortem Draft
- @pagerduty chat participant, voice-ready through VS Code Speech
- Optional push relay (relay/) for near-real-time updates
- End-to-end test in a real VS Code host against a mock PagerDuty API

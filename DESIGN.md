# Design

**Direction:** PagerDuty client brand inside VS Code. It's a client-brand direction rather than one of the `distinctive-ui` presets, chosen because the brief is to read as PagerDuty at a glance and as VS Code on contact.

This project deliberately breaks two house defaults, at the user's request (2026-10-28) and per the PRD:

- **Light and dark both ship**, following the VS Code colour theme, with a `pagerduty.theme` override.
- **Type is inherited** from the editor UI font, with the editor monospace (tabular figures) for incident numbers and timestamps. Not a single chosen family.

| | |
|---|---|
| Surfaces, text, borders | VS Code theme variables (`--vscode-*`) |
| Brand rule, primary action | PD Green `#048A24`, pressed PD Dark Green `#005A2F` |
| Links, accent text | Ultrateal `#117170` on light, Electric `#ADF07E` on dark |
| Focus ring | PD Dark Green on light, Electric on dark |
| Header band | Light Gray `#EFEFEF` on light, sideBar background on dark |
| State | Theme error / warning / passed colours, always with a distinct shape (filled dot, ring, tick) and a text label |
| Shape | Flat, 1px hairlines, radius ≤ 3px, no shadows or gradients |
| Motion | Colour transitions only, 140ms, off under `prefers-reduced-motion` |

**Recognisable idea:** a 3px PD Green rule across the top of the header band, over a compact status / number / urgency / service line. That's PagerDuty's incident header, reduced to VS Code density.

**AI surface:** Paige gets a 2px Ultrateal/Electric left rule and a sparkle icon, with no fills or gradients. It's the only AI-marked area, so the AI output is easy to tell apart from human notes.

**Layout:** Paige, the timeline and recent changes sit left and wide, and a hairline-separated rail on the right holds responders, likely files, notes, alerts and AIOps insights. The rail stacks under the timeline below 720px.

**House identity:** an info button (header end of the pane, plus *PagerDuty: About* in the views' overflow menu) credits FintonLabs. Stylesheet and pane HTML carry the MIT header.

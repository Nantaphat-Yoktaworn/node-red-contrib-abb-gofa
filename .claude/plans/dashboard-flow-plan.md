# Plan: GoFa Dashboard Flow

## Context
Create a Node-RED flow file (`flows/gofa_dashboard_flow.json`) that combines `node-red-contrib-abb-gofa` custom nodes with `node-red-dashboard` to give a browser-based UI for monitoring and basic control of the GoFa CRB 15000.

## Output file
`flows/gofa_dashboard_flow.json`

## Dashboard layout — 2 tabs

### Tab 1: "GoFa Status"
| Group | Widgets |
|-------|---------|
| Controller (width 6) | ui_text: State, Op Mode, RAPID; ui_gauge: Speed % |
| TCP Position (width 6) | ui_text: X, Y, Z (mm) |

Polling: inject every 2 s → `gofa-status` + `gofa-pose` in parallel → function nodes split outputs → ui widgets.

### Tab 2: "GoFa Control"
| Group | Widgets |
|-------|---------|
| Power & Motion (width 6) | btn: Motors ON (green), Motors OFF (yellow), Home (blue), STOP (red); ui_text: Last Action |
| Speed (width 6) | ui_slider 1–100 → `gofa-speed-set`; ui_text: result |
| Cartesian Jog (width 6) | 6 × jog buttons (X+/X-/Y+/Y-/Z+/Z-, 10 mm); 6 × rotation buttons (RX+/RX-/RY+/RY-/RZ+/RZ-, 5°) — all wire to single `gofa-jog` node; ui_text: Last Jog |

## Key nodes used
- `gofa-robot` (config) — shared connection, IP 192.168.20.18
- `gofa-status` → 4-output function → ui_text × 3 + ui_gauge × 1
- `gofa-pose` → 3-output function → ui_text × 3
- `gofa-motor` — motor on/off (payload.action override)
- `gofa-move` — HOME (payload.command override)
- `gofa-stop-motion` — E-stop
- `gofa-speed-set` — slider payload (number)
- `gofa-jog` — all 12 jog buttons converge here (payload.axis/dir/step override)

## Wiring notes
- inject → [status-node, pose-node] (parallel)
- btn-motor-on + btn-motor-off → motor-node → fn-cmd-result → txt-last-action
- btn-home → move-node → fn-cmd-result → txt-last-action
- btn-stop → stop-node → fn-cmd-result → txt-last-action
- 12 jog buttons → jog-node → fn-jog-result → txt-jog
- fn-cmd-result formats: `"✓ motoron"` or `"✗ <error>"`
- fn-jog-result formats: `"✓ X+10 → OK:X+10"`

## Verification
Import `flows/gofa_dashboard_flow.json` into Node-RED (drag & drop or Import menu).  
Prerequisites: `npm install node-red-dashboard` in Node-RED user dir.  
Open `http://<nodered-host>:1880/ui` — both tabs should appear.  
With robot online: Status tab auto-refreshes every 2 s; Control tab buttons send commands.

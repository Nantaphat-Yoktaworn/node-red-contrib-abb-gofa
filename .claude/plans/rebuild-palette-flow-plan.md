# Plan: Rebuild robot_palette_flow.json

## Context
The fork agent that was supposed to write the new `flows/robot_palette_flow.json` failed immediately ("Prompt is too long"). The current file still has only 13 of 39 gofa-* node types wired in. The task is to write the complete new flow directly.

## What needs to be done

**One file to write:** `flows/robot_palette_flow.json`

The file must be completely rewritten to include all 39 custom gofa-* palette nodes wired into a tabbed web dashboard served at `/robot`.

## Approach

Write the file directly with the Write tool (single call). Structure:

### Backend nodes (Node-RED flow)

**Keep all existing behavior:**
- Poll inject (200ms) → gofa-status + gofa-pose + gofa-joints → merge fn → flow.robot_data
- GET /robot → HTML page
- GET /robot/data → gofa-point-list → JSON with flow.robot_data + points
- POST /robot/move (existing: home/sethome/jog/joint-jog/goto) → **extend with movej and stop**
- POST /robot/savepoint, /robot/deletepoint, /robot/ctrlstate, /robot/sequence, /robot/sequence/stop

**New API routes (one http-in + prep fn + palette node + resp fn + http-response each):**
| Route | Node |
|---|---|
| POST /robot/ping | gofa-ping (output: {ok, rtt}) |
| POST /robot/gripper | gofa-grip (input: {action}) |
| POST /robot/zone | gofa-zone-set (input: zone string) |
| POST /robot/speed | gofa-speed-set (input: number 1-100) |
| POST /robot/rapid | gofa-rapid-exec (input: {action}) |
| POST /robot/leadthrough | routes to gofa-leadthrough-enable OR gofa-leadthrough-disable |
| POST /robot/io/list | gofa-io-list (input: {type} optional) |
| POST /robot/io/di | gofa-di-read (input: signal string as msg.payload) |
| POST /robot/io/ai | gofa-ai-read (same as DI) |
| POST /robot/io/do | gofa-do-write (input: {signal, value}) |
| POST /robot/io/ao | gofa-ao-write (input: {signal, value}) |
| POST /robot/rapidvar/read | gofa-rapid-var-read (input: {task, module, variable}) |
| POST /robot/rapidvar/write | gofa-rapid-var-write (input: {task, module, variable, value}) |
| POST /robot/sysinfo | gofa-system-info (output: {rwVersion, ctrlName, ctrlId, ...}) |
| POST /robot/elog | gofa-elog (output: {ok, entries:[{seqnum,msgtype,code,title,tstamp}]}) |
| POST /robot/file/read | gofa-file-read (input: {remotePath}) |
| POST /robot/file/upload | gofa-upload-mod (input: local path string) |
| POST /robot/points/export | gofa-points-export (output: {ok, count, points}) |
| POST /robot/points/import | gofa-points-import (input: {data:[...]}) |

**Background subscribe nodes (inject once on startup, 2s delay):**
- → gofa-subscribe-state → fn stores flow.ws_state
- → gofa-subscribe-pose → fn stores flow.ws_pose
- → gofa-subscribe-io (signal: DI10_1) → fn stores flow.ws_io
- → gofa-subscribe-var (task: T_ROB1, module: MainModule, variable: '', interval: 1000) → fn stores flow.ws_var

### HTML page (served by pg_fn function node)

Dark-themed, fullscreen layout using CSS flexbox:
- **Left sidebar** (~200px): title, LED status, opmode, RAPID state, speed bar, X/Y/Z, J1-J6 joints
- **Tab bar**: Motion | Points | Control | I/O | RAPID | System
- **Tab: Motion** — Cartesian jog (step input, +X/-X/+Y/-Y/+Z/-Z, +RX/-RX/+RY/-RY/+RZ/-RZ), Joint jog (J1-J6 ±), Absolute Joint Move (6 inputs + Move), Ping
- **Tab: Points** — Save current pose, Go/Delete from dropdown, Sequence runner (add/reorder/remove, dwell/loop/pingpong, Run/Stop), Export/Import JSON
- **Tab: Control** — Motors ON/OFF, RAPID Start/Stop/Reset PP, Home/Set Home/Stop Motion, Gripper ON/OFF, Speed slider + Set, Zone dropdown + Set, Lead-Through Enable/Disable
- **Tab: I/O** — List signals table, DI/AI Read, DO/AO Write
- **Tab: RAPID** — Read/Write RAPID variable (task/module/var/value inputs)
- **Tab: System** — System info table, Event log list, File read, Upload .mod

**HTML escaping strategy:** Use single quotes for all HTML attributes and all JavaScript string literals in the browser `<script>` block. Use `data-*` attributes for button string arguments (e.g. `data-jog='X+'`, `data-ctrl='motoron'`). This eliminates almost all need for `\"` escaping in the JSON func field.

## Verification

After writing: run `node -e "JSON.parse(require('fs').readFileSync('flows/robot_palette_flow.json','utf8'))"` from `C:\Users\anapa\nnnn\ABB-GoFa-12` to confirm valid JSON. Fix any parse errors before finishing.

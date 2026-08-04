# ABB GoFa 12 (CRB 15000-12/1.27) — Claude Code Context

Custom Node-RED palette (`node-red-contrib-abb-gofa`) for controlling an ABB GoFa 12 (CRB 15000-12/1.27) collaborative robot over a local network. No extra ABB licenses required.

This file is the **core index** — architecture, quick-reference tables, and pointers. Deep-dive history (what was tried, what failed, exact live-test evidence) lives in `docs/*.md`, one topic per file, linked inline below. Read a linked doc when you're touching that subsystem; don't need to read all of them upfront.

## Skills available

- `/abb-rws` — full RWS API reference (endpoints, auth, response parsing)
- `/omnicore-c30` — OmniCore C30 controller specs
- `/crb15000` — GoFa arm specs, joint limits, working range
- `/robot-status` — runs `check-status.js` against the live controller (Motors/Mode/RAPID/Speed/Socket); use before any live RWS/socket test, not just when explicitly asked
- `/mastership-test` — runs `mastership-test.js` to live-test any mastership-gated RWS endpoint (`resetpp`, `loadmod`, `activate`, RAPID var writes, or a newly-discovered one); prefer over hand-rolled `curl`

## Standalone scripts

`node-red-contrib-abb-gofa/check-status.js` — plain Node.js robot preflight check (Motors/Mode/RAPID/Speed via RWS + socket `PING`). Flags: `--full`, `--json`, `--discover` (LAN scan, also auto-triggered if the configured IP is unreachable). Overrides: `GOFA_IP`/`GOFA_RWS_PORT`/`GOFA_SOCKET_PORT`/`GOFA_USERNAME`/`GOFA_PASSWORD`. Exit codes: `0` OK, `1` RWS unreachable, `2` socket unreachable. Built on `createRobotClient()`, a RED-independent factory extracted from `gofa-robot.js`.

`node-red-contrib-abb-gofa/mastership-test.js` — wraps an arbitrary RWS POST in `withMastership()` (shared session, correct headers) for ad-hoc live testing of mastership-gated endpoints. Usage: `MSYS_NO_PATHCONV=1 node mastership-test.js <path> [body] [--hal]` (`MSYS_NO_PATHCONV=1` required in Git Bash; `--hal` for `loadmod`/`activate`-style endpoints).

## Architecture — two communication layers

**TCP Socket (port 1025)** — motion commands. `rapid/MainModule.mod` runs a socket server on the controller. Each Node-RED node opens a fresh TCP connection, sends one newline-terminated request, reads one newline-terminated reply, closes.

**RWS HTTPS (port 443)** — telemetry and motor control. REST API built into OmniCore. Auth is Basic on first request → cookie thereafter (auto-refresh on 401). All RWS calls go through `rwsGet()`/`rwsPost()` in `gofa-robot.js`. Responses are XHTML; values extracted with `parseXhtml(body, className)`.

Rule: **motion always goes through the socket; read-only data and motor control go through RWS.**

**Wire format is JSON**, not plain text: `{"cmd":"ping"}\n` → `{"status":"ok","cmd":"ping"}\n`/`{"status":"err",...}\n`. `ServeClient` dispatches by first byte: `{` → `DispatchJson` (current protocol), else → legacy `Dispatch`/`CleanCmd` plain-text parser (kept for raw telnet/curl, see `MANUAL_CONTROL.md`). Every node still calls `socketSend()` with legacy string tokens (`'PING'`, `'GOTOJ1;2;...'`); `translateToJSON()` converts to real JSON transparently — a node can also pass a plain object to skip the round-trip.

**Case-sensitivity is not uniform across JSON commands** — the legacy text protocol is fully case-insensitive, but `DispatchJson` handlers normalize case individually (`getvar`/`setvar` do, `setdo` originally didn't). Full detail, RAPID socket command table, and every protocol-level gotcha (RWS I/O `/set-value` vs `/set`, `SERVER_IP` drift, `loadmod`/`unloadmod`/`activate`, `\Conc` queue-depth crash, `VelSet` vs `SpeedRefresh`, mid-move STOP, chaining hazards, elog domain/severity, joint soft-limits, and more): **`docs/rapid-protocol-notes.md`**.

## Detailed docs (read when touching that subsystem)

| Doc | Covers |
|-----|--------|
| `docs/rapid-protocol-notes.md` | Full RAPID socket command table + every protocol gotcha/bugfix history (I/O write endpoint, SERVER_IP, loadmod/unloadmod, `\Conc` crash fix, VelSet vs SpeedRefresh, mid-move stop, elog, joint limits, chaining hazards) |
| `docs/egm.md` | Externally Guided Motion — `MainModuleEGM.mod`, `gofa-egm`/`gofa-egm-move`, mode switch/exit design (TRAP/`EGMStop`), UDP `EGM_PC` setup, superseded designs (do not re-implement) |
| `docs/background-led-task.md` | `BackgroundLed.mod` / `T_LED` — the separate RAPID task that survives `T_ROB1` stops, one-time RobotStudio setup, remote-reload mechanics, safety-controller LED override behavior |
| `docs/version-handshake-watchdog.md` | Module-vs-palette version handshake (`MODULE_VERSION`/`PALETTE_VERSION`), `flows/watchdog_flow.json` self-healing socket-wedge recovery, the `egmActive` exclusion bug |
| `docs/brake-check-reminder.md` | `flows/brake_check_reminder_flow.json` — Cyclic Brake Check elog-warning detection (read-only, doesn't trigger the check) |
| `docs/points-system.md` | On-robot point storage format, the combined `gofa-points` node (save/go/list/delete/export/import), migration history from the five removed single-purpose nodes |
| `docs/interactive-panels.md` | Editor-panel live-action buttons (separate code path from deployed flows), admin-route auth (`requireAdminAuth`), Known Signals dropdown |
| `docs/virtual-controller.md` | RobotStudio Virtual Controller workflow — doc-only, **not live-verified**, treat as "should work per docs" |

## RAPID socket protocol — quick reference

Logical command surface most nodes send via `socketSend()` (a string); `translateToJSON()` converts each to the real JSON wire request. Full gotchas: `docs/rapid-protocol-notes.md`.

| Command | What it does |
|---------|-------------|
| `HOME` | Move to home position |
| `SETHOME` | Capture current pose as home |
| `GOTOJx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveJ |
| `GOTOLx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveL |
| `X+20` / `Y-10` / `Z+5` | Translate TCP ±mm in base frame (max 50mm) |
| `RX+5` / `RY-10` / `RZ+15` | Rotate TCP ±° in tool frame (max 30°) |
| `J1+10` / `J3-5` | Jog single joint ±° (max 30°) |
| `SPEED50` | Speed override 1–100% via `VelSet` |
| `GETSPEED` | Read override back → `VAL:<value>` |
| `MOVEJ<j1;..;j6>` / `MOVEL<j1;..;j6>` | Absolute joint move in degrees |
| `ZONE<name>` | Path blend zone (FINE/Z1/Z5/Z10/Z20/Z50/Z100) |
| `STOP` | Halt motion (queued moves only, since 2.4.2 — see mid-move STOP in the protocol doc) |
| `PING` | Connectivity test |
| `GRIPON`/`GRIPOFF` | Stub only, manual testing |
| `GETVAR:<name>` / `SETVAR:<name>:<value>` | PERS variable read/write |
| `SETLED:<r>;<g>;<b>;<period>` / `RESETLED` | ASI status light |
| `SETDO:<name>:<value>` | Set DO by signal name |
| `EGMJOINT` | **`MainModuleEGM.mod` only** — enter EGM streaming mode, see `docs/egm.md` |

Move commands (`HOME`/`GOTOJ`/`GOTOL`/`MOVEJ`/`MOVEL`) are blocking, no `\Conc`, since 2.4.2; only jog commands still queue.

## Nodes (39 total)

| Node | Transport | Description |
|------|-----------|-------------|
| `gofa-robot` | config | Shared config: IP, RWS port 443, socket port 1025, creds, on-robot points path, optional per-axis Joint Limits override. Config dialog has a **Discover** button (LAN scan) |
| `gofa-setup` | RWS + Socket | One-click init: preflight → stop RAPID → unload conflicting module → upload/load `.mod` → resetpp → reload T_LED (best-effort) → motors on → start (poll-verified) → socket PING (version-compares) → confirm T_LED. See `docs/background-led-task.md` |
| `gofa-status` | RWS | ctrlstate, opmode, speedratio, RAPID execstate |
| `gofa-connection-status` | RWS+Socket+Background | RWS/socket/background checked independently. `payload.background`, `payload.moduleVersion`, `payload.egmActive`. Never raises — safe to poll (used by `watchdog_flow.json`) |
| `gofa-pose` | RWS | Current TCP pose (xyz + quaternion + config flags) |
| `gofa-joints` | RWS | All 6 joint angles (deg) |
| `gofa-system-info` | RWS | RobotWare version, controller identity |
| `gofa-elog` | RWS | Event log; Domain + Min Severity filters |
| `gofa-motor` | RWS | Motor on/off |
| `gofa-move` | Socket | HOME or SETHOME |
| `gofa-movej` | Socket | Absolute joint move; Joint/Linear; validates against Joint Limits first. Since 2.5.2 a *malformed* payload errors instead of silently falling back to the configured joints — only an absent/number/boolean/empty payload falls back (see `resolveJointsPayload`) |
| `gofa-jog` | Socket | Cartesian jog |
| `gofa-joint-jog` | Socket | Single joint jog |
| `gofa-grip` | RWS | Named DO on/off via `/set-value` (needs `Access: All`); Known Signals dropdown |
| `gofa-zone-set` | Socket | Path blend zone |
| `gofa-speed-set` | Socket | Global speed via `VelSet`; Set/Read. Chaining hazard, see protocol doc |
| `gofa-stop-motion` | RWS+Socket | Halt motion; `immediate` (default, halts in-progress) / `queued` (legacy) |
| `gofa-ping` | Socket | Connectivity test, round-trip time |
| `gofa-points` | RWS+Socket+fileservice | save/go/list/delete/export/import, all on-robot. See `docs/points-system.md` |
| `gofa-sequencer` | Socket+fileservice | Visit saved points in order; dwell, move-type override, loop, ping-pong |
| `gofa-stop-seq` | Socket+in-memory | Sets `_seqStop`, sends immediate `STOP` |
| `gofa-rapid-exec` | RWS | start/stop/resetpp/loadmod/unloadmod/activate. Chaining hazard, see protocol doc |
| `gofa-rapid-var-read` | Socket | Read PERS var (`GETVAR`) |
| `gofa-rapid-var-write` | Socket | Write PERS var (`SETVAR`) |
| `gofa-rapid-tasks` | RWS | List RAPID tasks + loaded modules |
| `gofa-file` | RWS | download/upload/delete on controller filesystem; upload auto-syncs SERVER_IP |
| `gofa-mod-edit` | RWS | Edit a controller-disk file in-editor; Load/Save/Delete-from-robot |
| `gofa-io-list` | RWS | List all I/O signals |
| `gofa-di-read` | RWS | Read DI; Known Signals dropdown |
| `gofa-do-write` | RWS/Socket/Background | Write DO; three transports, Known Signals dropdown |
| `gofa-leadthrough` | Socket+RWS | Hand-guiding enable/disable |
| `gofa-asi-led` | Socket/RWS/Background | ASI light RGB + blink; three transports (RWS is a dead end on this hardware) |
| `gofa-subscribe-state` | RWS WS | Push on controller state change |
| `gofa-subscribe-io` | RWS WS | Push on I/O change (real WS push); Known Signals dropdown |
| `gofa-subscribe-var` | RWS poll | Poll a RAPID variable |
| `gofa-subscribe-pose` | RWS poll | Poll TCP position |
| `gofa-subscribe-elog` | RWS WS | Push new event log entries |
| `gofa-egm` | Socket+UDP | EGM session control/telemetry. See `docs/egm.md` |
| `gofa-egm-move` | In-memory | Sets EGM joint target if active; else routes to fallback output |

## RWS key endpoints

| Endpoint | Method | Returns |
|----------|--------|---------|
| `GET /rw/panel/ctrl-state` | GET | `ctrlstate`: motoron/motoroff/guardstop/emergencystop |
| `GET /rw/panel/opmode` | GET | `opmode`: **UPPERCASE live** (`AUTO`,…) — unlike lowercase `ctrlstate`/`ctrlexecstate`; compare case-insensitively |
| `GET /rw/panel/speedratio` | GET | `speedratio`: 0–100 |
| `GET /rw/rapid/execution` | GET | `ctrlexecstate`: running/stopped |
| `GET /rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base` | GET | x,y,z mm + q1..q4 + cf1,cf4,cf6,cfx |
| `GET /rw/motionsystem/mechunits/ROB_1/jointtarget` | GET | rax_1..rax_6 degrees |
| `POST /rw/panel/ctrl-state` | POST | body: `ctrl-state=motoron`/`motoroff` |
| `POST /rw/rapid/execution/start` · `/stop` · `/resetpp` | POST | Remote Start/Stop UAS grants required; resetpp also needs edit mastership (auto-acquired) |
| `PUT /fileservice/$HOME/Programs/<file>` | PUT | Upload file to controller |
| `GET /rw/rapid/tasks` | GET | RAPID tasks: name, type, taskstate, excstate, active, motiontask |
| `GET /rw/rapid/tasks/{task}/modules` | GET | Modules loaded in a task: name, type (ProgMod/SysMod) |

## Default connection settings (this lab's robot)

| Setting | Value |
|---------|-------|
| Robot IP | `192.168.20.43` (as of 2026-08-04 — **drifts often, including whole-subnet changes**; never trust this table over a live check — see `reference_robot_ip_drift`/`project_robot_current_ip` memories) |
| RWS port | `443` (HTTPS, self-signed — `rejectUnauthorized: false`) |
| Socket port | `1025` |
| Username | `NNNN` |
| Password | *(not in this repo — see the `user-robot-credentials` memory; ABB factory default; `check-status.js`/`mastership-test.js` fall back to it)* |

**The shipped `gofa-robot` default was genericized for public npm release (2026-07-08)**: username defaults to ABB's factory `Default User`, no default password — a fresh public install carries none of this lab's creds. Repo is public: never write the real password into any tracked file.

## Software versions (RobotWare/controller re-confirmed 2026-07-16 via `check-status.js --full`)

| | |
|---|---|
| RobotWare | `7.21.0+229` |
| RWS protocol generation | `2.0` (path-based actions, `/set-value` not `/set`, `hal+json;v=2.0` for `loadmod`/`activate`) |
| Controller | OmniCore C30 Type A, identity `15000-501318` |
| Robot | CRB 15000-12/1.27 (GoFa 12) |
| RobotStudio | `2026.2`, build `26.2.11700.0` *(unverified since 2026-07-07)* |
| Node-RED | `5.0.0` |
| Node.js | `v24.18.0` |

Full product/option breakdown (RobotOS, ASI, EGM/Multitasking licensing) is in the `abb-rws` skill's version-snapshot section — re-pull via `GET /rw/system` + `GET /rw/system/products` rather than trusting this table blind after any ABB software update.

## Shared helpers (`node-red-contrib-abb-gofa/nodes/lib/`)

Extracted during the 2026-08-04 audit (2.5.2), when two bugs turned out to be "the
fix landed in only one of two duplicated copies". Prefer these over re-implementing:

| Helper | Purpose |
|--------|---------|
| `require-admin-auth.js` | Guard for state-changing editor endpoints; 403s when Node-RED has no `adminAuth` unless `allowInsecureLiveControl` is ticked |
| `gate.js` | "Output payload" toggle — strips `msg` down to `_msgid` unless enabled |
| `ws.js` | Minimal WebSocket client for RWS subscriptions (no `ws` dependency) |
| `rws-subscription.js` | Subscribe + WS connect + reconnect lifecycle shared by all three `gofa-subscribe-*` WS nodes |
| `drop-subscription.js` | Best-effort DELETE of a held subscription — **must** run before re-subscribing or every reconnect orphans one (controller caps concurrent sessions at 19) |
| `patch-server-ip.js` | Rewrites `SERVER_IP` in a `.mod` to match the config node's IP |
| `list-signals.js` | Parses the I/O signal list XHTML |

Also in `gofa-robot.js`: `escapeFileservicePath()` — **every** `/fileservice/` URL
must go through it. Node's HTTP client rejects an unescaped space client-side
("Request path contains unescaped characters"), so a raw path throws before it
reaches the controller (confirmed live 2026-08-04).

**Runtime vs. admin-route duplication**: `gofa-setup`, `gofa-connection-status`,
`gofa-rapid-exec`, `gofa-file`, `gofa-sequencer` and `gofa-points` each implement
their logic **once** and call it from both the deployed node and the editor panel.
Keep it that way — the two-copy pattern is what produced bugs 2 and 3.

## Repo layout

```
node-red-contrib-abb-gofa/        ← npm palette package
node-red-contrib-abb-gofa/check-status.js  ← standalone robot preflight check
node-red-contrib-abb-gofa/mastership-test.js ← standalone mastership-gated RWS test
rapid/MainModule.mod               ← RAPID socket server (must run on controller)
rapid/MainModuleEGM.mod            ← optional: MainModule.mod clone + EGM mode, see docs/egm.md
rapid/BackgroundLed.mod             ← optional: separate-task LED server, see docs/background-led-task.md
flows/gofa_demo_flow.json          ← one inject per node, for testing
flows/teach_flow.json              ← physical ASI-button teach workflow (own tab/config, see README)
flows/watchdog_flow.json           ← self-healing socket-wedge watchdog, see docs/version-handshake-watchdog.md
flows/mqtt_bridge_flow.json        ← publishes state/pose/io onto MQTT topics via core mqtt out
flows/brake_check_reminder_flow.json ← see docs/brake-check-reminder.md
docs/                               ← deep-dive reference docs, see table above
MANUAL_CONTROL.md                  ← curl/raw-TCP command reference for controlling the robot without Node-RED
.claude/commands/                  ← skills (/abb-rws, /omnicore-c30, /crb15000, /robot-status, /mastership-test)
.claude/memory/                    ← portable snapshot of Claude Code's project memory - read MEMORY.md first, see its README
.claude/plans/                     ← portable snapshot of past feature plans (design history, not active todos)
```

**Rule — every `.mod` edit must be synced into the npm package copy, same commit.** `rapid/*.mod` (repo root) is the source of truth; `node-red-contrib-abb-gofa/rapid/*.mod` is the copy that ships on npm **and the one `gofa-setup` reads at runtime**. `prepack.js` only re-syncs at `npm pack`/publish time, not on commit — after editing any root `rapid/*.mod`, copy it to `node-red-contrib-abb-gofa/rapid/` (or run `node prepack.js` from the package dir). Enforced: `test.js` has a byte-for-byte drift check.

**`flows/dashboard_flow.json` removed from `main` (2026-07-16), lives only on local `feature/mobile-pwa-dashboard` branch — not pushed to GitHub.** Full history: `.claude/memory/project_mobile_pwa_dashboard_branch.md`.

**On continuity across machines**: this project's Claude Code memory (lessons, decisions, live-test history) normally lives outside the repo, keyed to the local clone's working-directory path — doesn't travel on clone. `.claude/memory/` and `.claude/plans/` are manually-copied snapshots committed to the repo so a fresh clone starts with the same context. They go stale as new memory accumulates outside them — re-sync periodically. Start any "what's the history here" question with `.claude/memory/MEMORY.md`.

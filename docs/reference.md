# Node reference

Complete reference for every node, the `msg.payload` conventions they share, and the two optional
subsystems (EGM and the background task).

New here? Start with **[Getting started](getting-started.md)** instead — it walks you from an
unconfigured controller to a robot that moves. Something broken? See
**[Troubleshooting](troubleshooting.md)**.

---

## Contents

- [Nodes](#nodes) — every node, grouped by what it's for
- [Background task](#background-task-backgroundledmod--t_led) — the optional `T_LED` task
- [Teach workflow](#teach-workflow-physical-asi-buttons) — hand-guiding with the arm's physical buttons
- [Adding RAPID variables](#adding-rapid-variables) — exposing a new `PERS` variable to the palette
- [`msg.payload` conventions](#msgpayload-conventions) — what every node accepts as input
- [Default connection settings](#default-connection-settings)

The transport split (motion over TCP, everything else over RWS) is explained in the
[main README](../README.md#how-it-works).

---

## Nodes

Protocol key: **TCP** = RAPID socket server port 1025 · **RWS** = HTTPS REST API port 443 · **WS** = RWS WebSocket · **UDP** = EGM stream · **In-memory** = no network

### Read robot state

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-status** | RWS | Controller state, op-mode, speed %, RAPID exec state |
| **gofa-connection-status** | RWS + TCP | Per-layer health check (RWS calls + socket ping reported independently) — never raises a Node-RED error on failure, so it's safe to poll on a timer. Also reports each ping's module version vs. this palette's own, and whether a `gofa-egm` session is active |
| **gofa-pose** | RWS | TCP position (x, y, z mm + quaternion + config flags) |
| **gofa-joints** | RWS | All 6 joint angles in degrees |
| **gofa-system-info** | RWS | RobotWare version, controller name/ID/MAC |
| **gofa-elog** | RWS | Controller event log — Domain (category, e.g. Safety/Motion/RAPID) and Min Severity (info/warning+/error-only) filters |

### Motion

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-motor** | RWS | Motors on / off |
| **gofa-speed-set** | TCP | Speed override 1–100% |
| **gofa-move** | TCP | HOME (go to home) or SETHOME (save current pose as home) |
| **gofa-movej** | TCP | Absolute joint move `[j1..j6]` degrees ("Move Joints") — Move type: Joint (default) or Linear straight-line TCP path. Validates each target angle against the robot's Joint Limits before sending (see note below) |
| **gofa-jog** | TCP | Relative move — **Target**: `X`/`Y`/`Z` translate the TCP (mm, base frame), `RX`/`RY`/`RZ` rotate it (°, tool frame), `J1`–`J6` rotate a single joint (°). Replaces the separate `gofa-joint-jog` node, removed in 2.6.0 |
| **gofa-zone-set** | TCP | Path blend zone (fine / z1 / z5 / z10 / z20 / z50 / z100) |
| **gofa-stop-motion** | RWS + TCP | Halt motion. **Mode**: `immediate` (default) halts an in-progress `HOME`/`GOTOJ`/`GOTOL`/`MOVEJ`/`MOVEL` now via an RWS execution-stop, then auto `resetPP`+`start`s so the socket recovers (arm stays where it halted; needs Auto + motors on); `queued` is the legacy socket `STOP` that only cancels a not-yet-started move. A jog is halted immediately by either mode |
| **gofa-ping** | TCP | Round-trip latency test |
| **gofa-grip** | RWS | Digital output on/off for a gripper (same mechanism as `gofa-do-write`, with a preconfigured signal name + friendly on/off/true/false/gripon/gripoff input) |
| **gofa-leadthrough** | TCP + RWS | Hand-guiding on/off — action `enable` (sends STOP to clear queued moves, but only if RAPID is genuinely still running — skipped if it's already stopped, avoiding a ~5s wasted timeout) or `disable` |
| **gofa-asi-led** | TCP | Set ASI status light RGB color (`0–255`) and blink; supports counted software blink |

### Saved points

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-points** | RWS + TCP | All point operations, on one **Action** dropdown: `save` (read current pose, store under a name), `go` (look one up and move to it, Joint/Linear selectable), `list`, `delete`, `export` (dump the list to `msg.payload`, optionally to a file) and `import` (**replaces** the whole list from `msg.payload` or a file) |
| **gofa-sequencer** | TCP + RWS | Visit saved points in order — per-step dwell + move type override, loop count, ping-pong, startStep |
| **gofa-stop-seq** | TCP | Stop sequencer immediately (sends `STOP` socket + sets flag) |

> **One node, six actions (2.5.0).** `gofa-save-point`, `gofa-go-point`, `gofa-point-list` and
> `gofa-delete-point` were merged into `gofa-points` and **removed** — pick the action on the
> dropdown instead. Flows built before 2.5.0 will show "unknown node" for the four old types;
> replace each with a `gofa-points` node set to the matching action.

> **Points live on the robot, not on the Node-RED host.** Every point is stored in a single JSON
> file on the controller's own disk — the `gofa-robot` config node's **Remote Points Path**
> (default `$HOME/Programs/gofa_points.json`) — read and written purely over RWS `fileservice`
> `GET`/`PUT`, the same mechanism `gofa-file` uses. **No local `points.json` is involved**; the
> old Local storage option and its `msg.payload.storage` override were removed in 2.5.0. This
> means the points travel with the robot, not with the Node-RED install: reinstall Node-RED and
> your taught positions are still there. `gofa-sequencer` fetches the whole list once per run,
> not once per step. There's no concurrent-write protection on the file — fine for a human-paced
> "teach a point" workflow, not for two flows writing at once.
>
> Storing the list inside RAPID was considered first and rejected: RAPID's `string` type has a
> hard 80-character limit (see the move-type note below) that a growing list of named points
> would quickly exceed. A file managed over RWS sidesteps that entirely — it's plain HTTP, with
> no RAPID `string` involved.

> **Move type — Joint (MoveJ) vs Linear (MoveL):** `gofa-points` (action `go`) and `gofa-sequencer` let you pick how the robot reaches a saved point. **Joint (MoveJ)** is joint-interpolated and is the default whenever a move type isn't set or an invalid value is passed — it's the more predictable/reliable choice because RAPID has freedom in how each axis gets there, so it won't fault or slow drastically near a singularity. **Linear (MoveL)** forces a straight-line TCP path, which is useful for a controlled approach/retract near a workpiece but can hit a singularity or joint limit along that line even when both endpoints are fine on their own.

> **Joint soft limits:** `gofa-movej` checks every absolute-joint target against per-axis soft limits before sending, so an out-of-range value returns a clean error (`{ ok: false, error, joint, value, min, max }`) and never reaches the robot — instead of provoking a RAPID motion fault. Limits are configured on the **gofa-robot** config node's optional **Joint Limits** field and default to the CRB 15000-12/1.27 hardware working range (J1 ±270°, J2 ±180°, J3 −225°/+85°, J4 ±180°, J5 ±180°, J6 ±270°). Set a JSON array of six `[min, max]` pairs to enforce tighter limits for a cell with a restricted axis range. This applies to absolute joint moves only — Cartesian moves (`gofa-points` action `go`) can't be joint-limit-checked node-side without inverse kinematics and still rely on RAPID's own fault handling.

### RAPID program control

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-setup** | RWS + TCP | One-click first-run initialization for `T_ROB1`: upload the bundled `.mod` (SERVER_IP auto-synced) → load → reset PP → motors on → start → socket PING (also checks the module's version against this palette's), with a per-step report. **Also reloads `T_LED`/`BackgroundLed.mod` if that task already exists** (stop via its self-stop signal → upload → load → reset PP → confirm restart → ping) — best-effort, skipped cleanly if `T_LED` isn't set up. Cannot **create** the `T_LED` task itself — that's still a separate, one-time, RobotStudio-only step; see [Background task](#background-task-backgroundledmod--t_led). See [Quick start](getting-started.md#quick-start) |
| **gofa-rapid-exec** | RWS | `start` / `stop` / `resetpp` / `loadmod` / `unloadmod` / `activate` the RAPID program |
| **gofa-rapid-var-read** | TCP + RWS | Read a RAPID PERS variable via `GETVAR:<name>` socket command; falls back to a stale RWS module-text read if the variable isn't allow-listed |
| **gofa-rapid-var-write** | TCP | Write a RAPID PERS variable via `SETVAR:<name>:<value>` socket command — no RWS fallback exists (see below) |
| **gofa-rapid-tasks** | RWS | List RAPID tasks on the controller and the modules loaded in one of them |

> `gofa-rapid-exec` requires the RWS user to have **Remote Start** and **Remote Stop** grants (see Step 2). `resetpp`, `loadmod`, `unloadmod`, and `activate` additionally acquire edit mastership automatically.
>
> `loadmod` reloads a module file already on the controller's disk into a task — the RWS equivalent of the FlexPendant's **Load Module** step (see [Load and start on the FlexPendant](getting-started.md#load-and-start-on-the-flexpendant)). Use it after a **gofa-file** upload to make a running task pick up a changed `.mod` file without touching the FlexPendant. `activate` makes a named module the task's active/bound one — confirmed working but only needed if you must explicitly (re)bind a module by name; the common "edit and re-upload `MainModule.mod`" workflow only needs `loadmod`.
>
> **`unloadmod` removes a module from the task without touching the file on disk.** Necessary before `loadmod`-ing a *differently-named* module — `loadmod`'s `replace` option only replaces a module with the **same name**, so loading e.g. `MainModuleEGM` while `MainModule` is still loaded leaves **both** loaded. Since both declare `PROC main()`, RAPID then rejects `resetpp`/`start` with `(87,5): Global routine name main ambiguous` — confirmed live building the [EGM](#egm-externally-guided-motion) feature. Swap sequence either direction: `stop` → `unloadmod` (whichever module is currently loaded) → upload the other file → `loadmod` → `resetpp` → `start`.
>
> **`loadmod`, `unloadmod`, and `activate` all require RAPID to be stopped** — confirmed live: all three return HTTP 403 ("Operation not allowed for current PGM state") while RAPID is running. Stop RAPID first (`stop`), run `loadmod`/`unloadmod`/`activate`, then `start` again — with `resetpp` in between if the program pointer also needs resetting to Main.

> `gofa-rapid-var-read` / `gofa-rapid-var-write` use the TCP socket and work on standard OmniCore C30 without any extra RobotWare options. The variable must be listed in `TryGetVar` / `TrySetVar` in `MainModule.mod`. Built-in test variables: `nTestVar` (num) and `sTestMsg` (string). See [Adding RAPID variables](#adding-rapid-variables) below.
>
> **Why not a generic RWS variable read/write node?** RWS has a generic endpoint that can read/write any RAPID variable without editing RAPID code, but it 404s on this controller (`SYS_CTRL_E_UNRESOLVED_URL`) — not because of a missing license (that was checked and ruled out against ABB's own product manual). **Confirmed impossible on this controller, not just unworked-out**: ABB's own current documented `search-symbols` call (exact method/path/params, fetched live from their Developer Center) was reproduced verbatim against the real controller (RobotWare 7.21.0+229) and still fails — `POST /rw/rapid/symbols?action=search-symbols` returns `405 Method Not Allowed` even though the response's own `Allow` header claims POST is valid; every other path/method variant tried 404s or returns silently empty. See the `abb-rws` skill for the full investigation. The socket-based approach above is proven and needs no extra license, at the cost of having to allow-list each variable in `MainModule.mod`. Because there's no working RWS write endpoint at all, `gofa-rapid-var-write` has no fallback path the way `gofa-rapid-var-read` does — the only RWS-adjacent alternative (re-uploading the whole module with a new literal default via `gofa-file`) changes the compiled declaration, not the live value, and needs RAPID stopped and the program pointer reset to take effect, so it isn't a real substitute for a live write.
>
> **Reading a variable that isn't allow-listed:** `gofa-rapid-var-read` and `gofa-subscribe-var` fall back to reading the module's source text off the controller and regex-matching `name := value` for variables not in `TryGetVar`. **Confirmed live against a real controller that this fallback is stale** — it returns the compiled/declared value, not the variable's current runtime value (writing a new value via `SETVAR` and re-reading through this path still shows the old one). Both nodes mark it `stale: true` with a `warning` field rather than presenting it with the same confidence as a live socket read. For a genuinely live value, add the variable to `TryGetVar` instead.
>
> `gofa-rapid-tasks` is a plain read (no mastership needed) — useful for confirming what's actually loaded/running on the controller, e.g. after an upload or when a socket command mysteriously times out.

### Files and I/O

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-file** | RWS | Controller filesystem — action `download`, `upload` (local path in properties or via `msg.payload`; auto-syncs `SERVER_IP`), or `delete` (new in 2.0.0) |
| **gofa-mod-edit** | RWS | Edit a `.mod` (or any text) file on the controller's disk in the node's edit dialog — dropdown of files in `$HOME/Programs` (or a new filename), **Load from robot** / **Save to robot** buttons, `SERVER_IP` auto-synced on save; an input message re-uploads the stored content |
| **gofa-io-list** | RWS | List all I/O signals |
| **gofa-di-read** | RWS | Read a digital input (0 or 1) |
| **gofa-do-write** | RWS, TCP, or Background task | Write a digital output (0 or 1) — **Transport** dropdown: RWS `/set-value` (default), Socket `SETDO` (needs T_ROB1 running), or Background task (same `SETDO`, via `BackgroundLed.mod`'s own task — works while T_ROB1 is stopped) |

> **Writing a digital output needs the signal's Access Level set to `All` — unless you use the Socket or Background transport instead.** RWS writes go through `POST /rw/iosystem/signals/{name}/set-value` — this only succeeds if the target signal's `Access` config attribute is `All` (RobotStudio: `Controller` → `Configuration` → `I/O System` → `Signal` → `Access Level`; requires a controller restart to take effect). Left at the factory default (`Rapid|LocalManual`), the write correctly fails with `403`. **The action name matters too**: the IRC5/RWS-1.0-documented `/set` path 405s unconditionally on OmniCore/RWS 2.0, regardless of Access Level — `/set-value` is the real OmniCore action (see the [405 troubleshooting entry](troubleshooting.md#rws-returns-405-method-not-allowed) below). This project has no analog I/O (`gofa-ai-read`/`gofa-ao-write` were removed) — the standard OmniCore C30/CRB 15000 combo has no native analog port; ABB's `DSQC1032` Analog Add-On module (attaches to an existing digital Scalable I/O base device) would be needed to add one.
>
> **`gofa-do-write`'s Socket transport** sends the write over the TCP socket instead of RWS — RAPID's `SetDO` against an explicit per-signal allow-list in `MainModule.mod` (`ABB_Scalable_IO_0_DO1`–`DO16`), bypassing the Access Level restriction entirely (RAPID always has access to its own I/O). Needs RAPID actually running. **Gotcha confirmed live**: the signal name is matched **case-sensitively** on this path (RAPID's `DispatchJson`, added in the JSON socket-protocol rewrite, gets the raw name with no `CleanCmd`-style uppercasing) — `gofa-do-write.js` upper-cases the name before sending so this palette's own mixed-case default (`ABB_Scalable_IO_0_DO1`) still works; if you write your own socket call by hand, remember to upper-case the signal name yourself.
>
> **`gofa-do-write`'s Background task transport** is the same `SETDO` mechanism as Socket, but sent to `BackgroundLed.mod` running in its own RAPID task (`T_LED`) instead of `T_ROB1` — it keeps working even while `T_ROB1` is stopped (teach workflow, EGM session). Requires the one-time RobotStudio task setup in [Background task](#background-task-backgroundledmod--t_led) below.

### Real-time subscriptions

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-subscribe-state** | WS | Push on every controller state change; one-shot mode polls once per inject |
| **gofa-subscribe-io** | WS / poll | Push on every I/O signal change (real WebSocket push); falls back to 500 ms polling only if the subscription request itself fails (e.g. `400`); one-shot mode polls once per inject |
| **gofa-subscribe-var** | RWS poll | Poll a RAPID variable on an interval |
| **gofa-subscribe-pose** | RWS poll | Poll TCP position on an interval |
| **gofa-subscribe-elog** | WS | Push new controller event log entries in real time; same Domain + Min Severity filters as `gofa-elog` |

> **One-shot checkbox** — both `gofa-subscribe-state` and `gofa-subscribe-io` have a **One-shot** option in their properties. When checked, each inject triggers a single poll and returns the current value immediately without opening a persistent subscription.
>
> **Domain filters by category, not severity.** `gofa-elog`/`gofa-subscribe-elog`'s **Domain** dropdown picks an ABB log category (Common, Operational, Safety, Motion, RAPID, …) — it has nothing to do with how severe an entry is. Every entry also has a severity (`msgtype`: info/warning/error) completely independent of its domain; use **Min Severity** to filter on that instead. Want "just the real problems"? Set Min Severity to Warning+ or Error only — picking a domain alone won't filter out info-level noise like "Motors On state."
>
> **`gofa-subscribe-elog`'s WebSocket push only carries a reference**, not the entry itself — the node does one extra RWS `GET` per new entry to fetch its fields before emitting. This is different from `gofa-subscribe-state`/`gofa-subscribe-io`, whose pushes already carry the changed value.

### EGM (Externally Guided Motion)

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-egm** | Socket + UDP (EGM) | Session control + telemetry — Action dropdown (`start`/`stop`); `start` sends `EGMJOINT` over the TCP socket before switching to UDP, `stop` sets a signal via RWS |
| **gofa-egm-move** | In-memory | Sets the live target if a `gofa-egm` session is active; otherwise routes to a fallback output |

`gofa-egm` streams joint positions over EGM — a UDP/protobuf channel built into RobotWare
(option `3124-1`, standard on OmniCore), capable of sub-10ms closed-loop motion. Everything
else in this palette goes through the TCP socket server or RWS, both of which top out around
100–500ms — EGM is the only path here for real-time control. **Confirmed live** (2026-07-09):
real motion, closed-loop — a `+3°` target on one joint produces a smooth ramp visible in the
returned feedback, converging on the commanded value and back.

**Two nodes, split by job.** `gofa-egm` only starts/stops the session and emits telemetry — it
has an **Action** dropdown (`Start EGM` / `Stop EGM`, same pattern as `gofa-motor`/
`gofa-rapid-exec`: put one node instance per action in a flow, each fed by a plain inject).
`gofa-egm-move` is a separate node that sets the actual movement target: send it a `[j1..j6]`
array and it checks whether a `gofa-egm` session is active on the same Robot — if so, it updates
the live target (**output 1**); if not, it routes the same message unchanged to **output 2**
(fallback) instead of erroring, so you can wire that straight into `gofa-movej` for an automatic
non-EGM move instead.

**This is opt-in and needs its own RAPID module.** `rapid/MainModule.mod` (the default covered
by the rest of this README) has no EGM support. `rapid/MainModuleEGM.mod` is a full clone of
it — identical TCP command server — plus one added command, `EGMJOINT`, that switches the
controller into a blocking EGM session. Only one of the two can be loaded on the controller at
a time.

#### Loading MainModuleEGM.mod

Same as [uploading MainModule.mod](getting-started.md#3-upload-and-run-the-rapid-program), but with one
extra required step. **Switching between the two modules always needs an explicit unload
first** — see the `unloadmod` note under [RAPID program control](#rapid-program-control)
above for why (`loadmod`'s `replace` only replaces a same-named module; skipping the unload
leaves both loaded and RAPID rejects `resetpp`/`start` with an ambiguous-`main` error). Full
sequence, either direction:

1. `gofa-rapid-exec` → `stop`
2. `gofa-rapid-exec` → `unloadmod` (module = whichever is currently loaded, e.g. `MainModule`)
3. `gofa-file` (action upload) → the other file (e.g. `rapid/MainModuleEGM.mod`, remote path
   `$HOME/Programs/MainModuleEGM.mod`)
4. `gofa-rapid-exec` → `loadmod` (module path from step 3)
5. `gofa-rapid-exec` → `resetpp`
6. `gofa-rapid-exec` → `start`

There's no ready-made sub-flow for this sequence in `flows/gofa_demo_flow.json` — wire the six
steps above by hand with a `gofa-rapid-exec`/`gofa-file` node each (with `change` nodes clearing
`msg.payload` between chained `gofa-rapid-exec` nodes — see the chaining note in
[msg.payload conventions](#msgpayload-conventions)). If the wrong module ends up loaded anyway,
`gofa-egm`'s `start` action fails with a clear "load MainModuleEGM.mod first" error instead of
hanging.

#### One-time controller setup (RobotStudio, not done by any node)

A UDP Unicast Device named `EGM_PC`: **Controller** → **Configuration** → **Communication** →
**UDP Unicast Device** → right-click → **New UDP Unicast Device...** — `Name: EGM_PC`,
`Type: UDPUC`, `Remote Address:` the Node-RED host's IP on the robot's subnet,
`Remote Port Number: 6510` (must match `gofa-egm`'s configured UDP Port), `Local Port Number: 0`.
**Requires a controller restart to take effect.** Also
needs a firewall rule on the Node-RED host allowing inbound UDP on that port.

> **`EGM_PC`'s Remote Address drifts the same way the robot's own IP does** (see
> [Set your robot IP](getting-started.md#1-set-your-robot-ip)) — if the Node-RED host's IP changes, `EGM_PC`
> needs updating too, or `gofa-egm`'s `start` will succeed (`OK:EGMJOINT`, UDP binds fine) but
> zero frames will ever arrive. Confirmed live: this looks identical to a firewall problem
> ("No EGM frames received within 2s") — check `EGM_PC`'s configured address first.

> **Caution — tool load data:** per ABB's EGM Application Manual, the robot should have correct
> tool load data (`LoadIdentify`) before starting EGM — incorrect load data can cause servo
> torque overruns or safety halts when EGM issues fast corrections. As of 2026-07-21, with no
> tool physically mounted, `MainModuleEGM.mod`/`MainModule.mod` both target `tool0` (RAPID's
> built-in empty-flange tool) instead of the placeholder `tGripper` tooldata, so there's no
> false load data to worry about right now. `tGripper` is still declared, unused, as a
> placeholder — once a real gripper is mounted, run `LoadIdentify` (or otherwise measure its
> real mass/CoG/inertia/TCP offset), populate `tGripper` with the real values, and switch the
> tool argument in both `.mod` files back from `tool0` to `tGripper` before relying on EGM (or
> any motion) with that tooling attached.

#### Input / output

**`gofa-egm`**: `msg.payload` overrides the node's configured Action — a bare `"start"`/`"stop"`
string or `{ action: "start" }` / `{ action: "stop" }`; anything else (including a plain inject's
empty/date payload) just runs the configured Action. Output: `{ ok: true, joints, seqno,
mciState, motorsOn, convergence, source: 'egm' }`, throttled (config option, default 100ms —
real EGM frames arrive every ~24ms).

**`gofa-egm-move`**: `msg.payload` = an array of 6 numbers (absolute joint target, degrees) or
`{ joints: [...] }`. Output 1 (target sent) or output 2 (fallback — EGM session not active)
fires, never both; `msg.payload` is normalized to a bare `[j1..j6]` array on either output.

Full details in each node's Node-RED sidebar help.

**Ending a session is not automatic — always use `gofa-egm`'s `stop` action, don't just stop
sending targets.** EGM's own comm-timeout mechanism does not reliably end a session on its own
(confirmed live: going quiet with a session already connected can leave the controller blocked
for minutes with no recovery). `stop` (or closing/redeploying the `gofa-egm` node while a
session is active) sets a dedicated signal via RWS that a RAPID interrupt watches — the
controller ends the EGM session gracefully (`EGMStop`, from a TRAP) and returns to normal TCP
serving on its own; the RAPID task itself never actually stops, so this is fast (~1s) and
doesn't risk leaking controller-side EGM resources the way an external task-level stop would.

While a session is active, every other socket-based node (`gofa-jog`, `gofa-points` action `go`, etc.)
fails fast ("connection refused") instead of hanging — the TCP server is genuinely down for
that duration, same as any other time `MainModule.mod`'s socket server isn't running.

---

## Background task (`BackgroundLed.mod` / `T_LED`)

**What this unlocks.** The [teach workflow](#teach-workflow-physical-asi-buttons) stops all of
`T_ROB1` (not just motion) before hand-guiding — which also kills `MainModule.mod`'s TCP socket
server, since it's part of `T_ROB1`'s own program loop. That would normally mean no LED feedback,
no digital-output writes, and no way to tell "T_ROB1 is intentionally stopped" from "the whole
controller is unreachable" during that window. `BackgroundLed.mod` fixes this by running a small,
separate RAPID module in its **own** RAPID task (`T_LED`) — one that keeps answering even while
`T_ROB1` is fully stopped. It's what backs:

- `gofa-asi-led`'s and `gofa-do-write`'s **Background task** transport option
- The teach workflow's LED feedback (all three of its `gofa-asi-led` nodes use this transport)
- `gofa-connection-status`'s `background` field, which is what lets a watchdog flow tell "`T_ROB1`
  specifically wedged/stopped" apart from "controller unreachable"

**Not required for anything else** — every other node in this palette works fine without it.
`gofa-setup` cannot *create* this task — creating a brand-new RAPID task is not possible over RWS
at all (tested thoroughly — every documented and undocumented endpoint shape for it returns
`405`), only RobotStudio can create one, so the one-time setup below is genuinely manual, not a
gap in the node. Once the task exists, though, `gofa-setup` **does** keep it up to date
automatically on every run — see "Updating `BackgroundLed.mod` later" below.

**Prerequisite**: RobotWare Multitasking `[3114-1]` licensed on the controller (check RobotStudio
→ **Controller** → **Installation** → **Modify Installation** → look for it under **Options**,
or `GET /rw/system` over RWS).

**One-time setup:**

1. **Upload `BackgroundLed.mod`** — add a `gofa-file` node (action **upload**), point its Local
   Path at the bundled `rapid/BackgroundLed.mod`. This auto-syncs `SERVER_IP` the same way
   `gofa-setup`/`gofa-file` already do for `MainModule.mod`.
2. **RobotStudio → Controller tab → Configuration → Controller → Task → right-click → New
   Task** — opens an **Instance Editor** dialog. Set:
   - **Task**: `T_LED` (this name is hardcoded — `gofa-robot`'s **Background Services Port**
     config field talks to whichever task is listening on that port, but the task itself must
     be named `T_LED` for `gofa-setup`'s automatic reload, below, to find it)
   - **Type**: `Semistatic` — starts automatically at power-up and, unlike a `Normal` task like
     `T_ROB1`, is not part of the normal RWS/FlexPendant Program Start/Stop cycle (that's the
     entire point — it needs to survive `T_ROB1` being stopped)
   - **Main Entry**: `main` (default — leave as-is)
   - **TrustLevel**: `No Safety`, **not** the field's own default. A brand-new task defaults to
     the same trust level as `T_ROB1`'s real motion task — meaning an unhandled error in this
     small LED/IO utility task would otherwise be treated as a full system failure, which is
     disproportionate for what it does.
   - Everything else (**Task in Foreground**, **Check Unsolved References**, **Use Mechanical
     Unit Group**, **Hidden**, **RMQ Type**/**Mode**, etc.) can stay at its default.
   - **OK**.
3. **Restart the controller.** Required before `T_LED` shows up as a selectable task anywhere
   else (FlexPendant, RWS) — it won't appear until after this restart.
4. **Load `BackgroundLed.mod` into `T_LED`** — on the FlexPendant: ABB menu → **Program
   Editor** → task selector (top) → switch to **T_LED** → **File** → **Load Module...** →
   `$HOME/Programs/BackgroundLed.mod` (already uploaded in step 1) → confirm. Load it into
   `T_LED` specifically, **not** `T_ROB1` (that would collide with `MainModule.mod`'s own
   `PROC main()`, the same "Global routine name main ambiguous" conflict as loading both
   `MainModule` and `MainModuleEGM` at once).

5. **Set `ABB_Scalable_IO_0_DO15`'s Access Level to `All`** — RobotStudio: `Controller` →
   `Configuration` → `I/O System` → `Signal` → `ABB_Scalable_IO_0_DO15` → **Access Level** → `All`
   (requires a controller restart to take effect, same as any other RWS-write-driven signal in
   this palette — see the [`gofa-do-write` Access Level note](#files-and-io) above). This signal
   is `BackgroundLed.mod`'s dedicated remote self-stop trigger (see below) — deliberately not
   shared with `gofa-egm`'s own `DO16` graceful-stop signal on `T_ROB1`, since digital I/O is
   global/task-independent and sharing one would make an EGM stop also kill `T_LED`.

After loading the module, verify with a `gofa-do-write` node set to the **Background task** transport
(or `gofa-asi-led` set the same way) — a successful write confirms `T_LED` is up and answering.

**Updating `BackgroundLed.mod` later is now fully remote — `gofa-setup` handles it.** The bundled
`BackgroundLed.mod` (2.4.13+) includes a small `TRAP`/`ISignalDO` self-stop, the same pattern this
palette already uses for `gofa-egm`'s graceful EGM stop: setting `ABB_Scalable_IO_0_DO15` triggers
a plain RAPID `Stop`, which — unlike an external RWS/FlexPendant stop — actually works on a
`SEMISTATIC` task. `gofa-setup` uses this automatically: every time it runs, it also checks for a
`T_LED` task and, if present, stops it, re-uploads the current `BackgroundLed.mod`, reloads it,
and restarts it, right alongside its usual `T_ROB1` setup — no FlexPendant needed. This only
applies going forward: the **one-time setup above (steps 1–5) still needs to happen once**,
manually, to get this self-stop-capable version of `BackgroundLed.mod` loaded onto a controller
that doesn't have it yet — `gofa-setup` can't bootstrap a task it has no way to stop in the first
place. If `T_LED` isn't set up at all, `gofa-setup` just skips this part cleanly (no error) — see
the [`gofa-setup` row](#rapid-program-control) above and `docs/background-led-task.md` for
the full mechanics, including two live-confirmed quirks not documented anywhere by ABB: `T_LED`'s
`loadmod` needs the controller's overall RAPID execution stopped (not just `T_LED`'s own state),
and bringing it back up sometimes takes a second identical `start` call.

---

## Teach workflow (physical ASI buttons)

`flows/teach_flow.json` is a standalone flow — its own tab, its own copy of the
`gofa-robot` config node (same `cfg1` id as the demo flow, so importing both is safe; Node-RED
de-dupes config nodes by id). It uses the two physical buttons on the GoFa's arm
(`Asi1Button1`/`Asi1Button2` — plain digital signals, readable/subscribable regardless of what
the FlexPendant's Wizard menu has them assigned to) to hand-guide the arm without touching the
FlexPendant at all:

**Precondition: robot already in Auto mode, Motors On, RAPID running** — this flow doesn't set
that up, it assumes it and checks for it.

1. **Press Button 1** — stops RAPID, confirms it actually reached the stopped state (bounded
   live poll, not a fixed guess-and-hope delay), then enables lead-through. The ASI status
   light turns solid yellow as a physical "teach mode active" cue — no screen needed. (Yellow
   was chosen deliberately: it's the same color the safety controller's own motion-override
   uses while the arm is actually being moved, so the LED doesn't visibly change color between
   "idle" and "moving" during the session — one steady color throughout.)
2. Hand-guide the arm.
3. **Press Button 2** (any time while lead-through is active) — saves the current pose as a new
   point (via `gofa-points` action `save`, written to the robot controller's own disk — see
   [Saved points](#saved-points)), and the ASI light flashes yellow
   twice as a physical "saved" confirmation, then returns to solid yellow immediately. Pressing
   it while *not* in teach mode is safely ignored with a clear message instead of silently
   saving an unintended pose (the LED doesn't flash in this case either — an implicit "nothing
   happened" cue).
4. **Press Button 1 again** — disables lead-through, resets the program pointer, restarts
   RAPID — back to exactly the state before step 1, including the ASI light resetting to its
   normal solid-green RAPID-running state.

> Both button-watcher branches insert a short settle delay (2s on Button 1, 3s on Button 2)
> between "start watching" and actually subscribing over WebSocket — on a Node-RED restart, a
> subscribe request fired before the robot's RWS session is ready gets rejected with
> `WebSocket upgrade rejected: HTTP 500`; the delay avoids racing that.

> **LED feedback requires a one-time controller setup.** RAPID (and its socket server) is
> stopped for the entire hand-guiding session, so the three `gofa-asi-led` nodes in this flow
> use the `background` transport — `BackgroundLed.mod` running in its own RAPID task, alongside
> `T_ROB1`, so it keeps answering even while `T_ROB1` is stopped. This needs `BackgroundLed.mod`
> uploaded and assigned to a second task (RobotWare Multitasking) before the lights will work —
> see [Background task](#background-task-backgroundledmod--t_led) below for the exact one-time
> RobotStudio steps.

Every press re-reads live robot state (`gofa-status`) to decide what to do rather than trusting
an internal flag, so it's self-healing across a Node-RED restart mid-session. Every multi-step
sequence is gated on the previous step's success (a failed RAPID stop won't blindly proceed into
enabling lead-through, etc.) and every step's result is visible in its own debug output — check
the debug sidebar if a press doesn't seem to do anything. Every producing node in this flow has
**Output payload** enabled (unlike this package's other example flows, which leave it off by
default) since the flow's own routing logic depends on reading the real `msg.payload` at every
step, not just on the debug sidebar being useful.

---

## Adding RAPID variables

`gofa-rapid-var-read` and `gofa-rapid-var-write` communicate via the TCP socket using `GETVAR:<name>` and `SETVAR:<name>:<value>` commands. The supported variables are declared inside `MainModule.mod` — you add one `ELSEIF` block per variable in two functions:

```rapid
! In TryGetVar — read side
ELSEIF varname = "MYSPEED" THEN
    SocketSend clientSocket \Str:=("VAL:" + NumToStr(nMySpeed, 6) + ByteToStr(10\Char));

! In TrySetVar — write side
ELSEIF varname = "MYSPEED" THEN
    IF NOT StrToVal(valstr, nMySpeed) THEN
        SocketSend clientSocket \Str:=("ERR:PARSE" + ByteToStr(10\Char));
        RETURN TRUE;
    ENDIF
    SocketSend clientSocket \Str:=("OK:SETVAR" + ByteToStr(10\Char));
```

> Variable names in socket commands are **uppercased** automatically (`nMySpeed` → sent as `GETVAR:nMySpeed` → matched as `NMYSPEED`). String values sent to `SETVAR` preserve their original case and spaces.

After editing `MainModule.mod`, re-upload it and reload on the FlexPendant.

---

## msg.payload conventions

Every node that has configurable action parameters follows the same priority chain:

```
msg.payload  →  node property (editor)  →  built-in default
```

### Nodes with configurable payload

| Node | Accepted payload forms | Default |
|------|----------------------|---------|
| **gofa-motor** | `'motoron'` / `'motoroff'` (string) · `{ action: 'motoron' }` | `motoron` |
| **gofa-move** | `'HOME'` / `'SETHOME'` (string) · `{ command: 'HOME' }` | `HOME` |
| **gofa-rapid-exec** | `'start'` / `'stop'` / `'resetpp'` / `'loadmod'` / `'unloadmod'` / `'activate'` (string) · `{ action: 'start' }` · for `loadmod`: `{ action: 'loadmod', task, modulePath, replace }` · for `unloadmod`/`activate`: `{ action: 'unloadmod', task, module }` | `start` |
| **gofa-egm** | `'start'` / `'stop'` (string) · `{ action: 'start' }` | `start` |
| **gofa-egm-move** | array of 6 numbers (absolute joint target, degrees) · `{ joints: [...] }` | (none — required) |
| **gofa-speed-set** | number or string `1`–`100` | `50` |
| **gofa-zone-set** | `'fine'` / `'z1'` / `'z5'` / `'z10'` / `'z20'` / `'z50'` / `'z100'` | `z10` |
| **gofa-grip** | `true` / `1` / `'on'` / `'gripon'` or `false` / `0` / `'off'` / `'gripoff'` · `{ action: 'on' }` | `on` |
| **gofa-jog** | `{ target, dir, step }` — `target`: `X`/`Y`/`Z`/`RX`/`RY`/`RZ`/`J1`–`J6`. `{ axis, ... }` and `{ joint, ... }` still work as aliases for pre-2.6.0 flows | X, +, 10 |
| **gofa-movej** | `[j1,j2,j3,j4,j5,j6]` · `{ j1..j6 }` · `{ joints: [...] }` · a JSON-array string. A **malformed** target (wrong-length array, object with no joint keys) is an **error** since 2.5.2 — see below | `[0,0,85,0,0,0]` |
| **gofa-points** | `{ action }` selects the action (**only** an object field — a bare string never does). Then per action: `save`/`go`/`delete` take a bare string or `{ name }` / `{ id }` as the point name, `go` also `{ moveType }` (`"J"`/`"L"`); `export`/`import` take a bare string or `{ path }` / `{ savePath }` / `{ loadPath }` as the file path; `import` with no path reads the payload itself (an array, or `{ points: [...] }`); `list` ignores the payload | (property) |
| **gofa-rapid-var-read** | `{ task, module, variable }` | T_ROB1 / MainModule / (property) |
| **gofa-rapid-var-write** | bare value · `{ variable, value }` | (property) |
| **gofa-rapid-tasks** | `{ task }` — overrides which task's modules to list | T_ROB1 / (property) |
| **gofa-do-write** | `0` or `1` (number) · `{ signal, value, transport }` — `transport`: `'rws'`/`'socket'`/`'background'` | signal: ABB_Scalable_IO_0_DO1, value: 0, transport: rws |
| **gofa-di-read** | signal name (string) | `ABB_Scalable_IO_0_DI1` |
| **gofa-subscribe-io** | `{ signal }` | `ABB_Scalable_IO_0_DI1` |
| **gofa-subscribe-var** | `{ task, module, variable }` (toggles polling) | T_ROB1 / MainModule / (property) |
| **gofa-subscribe-pose** | Toggles on/off each input regardless of payload — starting reads `{ interval }` ms if present; already running always stops, even if a new `interval` is sent | 500 ms |
| **gofa-file** (download/delete) | remote path (string) · `{ remotePath, encoding }` | `$HOME/Programs/MainModule.mod` |
| **gofa-file** (upload) | `Buffer` · local path (string) · `{ localPath, remotePath }` | (property) |
| **gofa-elog** | `{ domain, count, minSeverity }` | domain: 1, count: 10, minSeverity: 1 (all) |
| **gofa-asi-led** | `'red'`/`'green'`/`'yellow'`/`'off'`/etc. · `false`/`0` (off) · `{ color, r, g, b, period, blinkCount, blinkMs }` · `'reset'` (restore default) | node defaults |
| **gofa-sequencer** | `{ steps, dwell, moveType, loop, pingpong, count, startStep }` — `steps[i].moveType` overrides per-step; `startStep` is 1-based | (property) |
| **gofa-io-list** | `{ type }` — optional filter, e.g. `'DI'`/`'DO'`/`'GO'` | (property / all types) |

### Trigger-only nodes (no payload needed)

These nodes fire on any input message and ignore `msg.payload`:

`gofa-status` · `gofa-pose` · `gofa-joints` · `gofa-system-info` · `gofa-ping` ·
`gofa-stop-motion` · `gofa-stop-seq` ·
`gofa-leadthrough` ·
`gofa-subscribe-state` · `gofa-subscribe-elog`

> **gofa-asi-led** — `msg.payload` is required. Use a color string (`'yellow'`), a preset object (`{ color: 'green', blinkCount: 3, blinkMs: 250 }`), or `'reset'` to restore the controller's default green LED. Omit `blinkCount` (or set to `0`) to use the hardware `period` signal for continuous blinking instead.

---

## Default connection settings

| Setting | Value |
|---------|-------|
| Robot IP | `192.168.125.1` (ABB's factory service-port address — set your own in the config node) |
| RWS port | `443` (HTTPS, self-signed cert) |
| Socket port | `1025` |
| Background services port | `1026` (only used by the optional `T_LED` task) |
| Username | `Default User` (set your own in the config node) |
| Password | *(none shipped — set in the config node)* |

The self-signed HTTPS certificate on the controller is accepted automatically (`rejectUnauthorized: false`).

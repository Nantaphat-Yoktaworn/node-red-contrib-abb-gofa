---
name: project-background-led-task
description: "BackgroundLed.mod (T_LED, semistatic task) implemented + fully live-verified 2026-07-17 against the real deployed teach_workflow_flow.json (physical buttons, not simulated) — fixes ASI LED feedback during teach-mode lead-through; RWS can't create RAPID tasks; SEMISTATIC survives execution/stop; ABB's own safety LED overrides (white=activating, yellow=moving) are real and expected; also fixed a shared-cookie race bug across all 3 WS-subscribe nodes found while testing"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4d88d4e8-145d-4608-bf98-f2a7648e9270
---

`flows/teach_workflow_flow.json`'s teach workflow stops `T_ROB1` (`POST
/rw/rapid/execution/stop`) before enabling lead-through — necessary for hand-guiding, but it
also kills `MainModule.mod`'s socket server (part of `T_ROB1`'s own `main()` loop), so
`gofa-asi-led`'s Socket transport timed out for the whole teach session (the bug that started
this whole investigation — user reported "Error: socket timeout", no LED blink on save).

**RWS `/set-value` (the fix already used for `gofa-do-write`) turned out to be a dead end for
this specific hardware.** The ASI LED signals (`Asi1LedRed`/`Green`/`Blue`/`Period`) don't
expose an editable `Access Level` in RobotStudio at all — confirmed by the user directly, not
assumed. Root cause found live: this controller already runs a task named `T_GOFA_LED`
(`GOFA_Main` `SysMod`, entry point `GOFA_LedMain`) — almost certainly ABB's own built-in driver
for the collaborative-robot status light. Confirmed genuinely protected: `GET .../modules/
GOFA_Main/text` → `500 "Module encoded, noview or readonly"`, and its own `CAB_TASKS` config
instance is `rdonly: true` with an empty attribute list. Do not attempt to read/edit/repurpose
this task — added an explicit warning about this in `CLAUDE.md`.

**Fix: a second RAPID task, not RWS.** `rapid/BackgroundLed.mod` — a small standalone module
(own copies of the JSON-parsing helpers; RAPID tasks can't share local PROCs across tasks) —
serves `ping`/`setled`/`resetled` on its own TCP port (1026) from a new task (`T_LED`,
`SEMISTATIC`). Relies on RobotWare Multitasking `[3114-1]`, confirmed genuinely licensed on this
controller.

**Key empirical findings, all confirmed live against the real robot (not inferred from docs):**
1. **`SEMISTATIC`/`STATIC` tasks survive `POST /rw/rapid/execution/stop`, `NORMAL` doesn't.**
   Stopped `T_ROB1` (no motion) and polled all tasks — the two pre-existing semistatic tasks
   (`SC_CBC`, `T_GOFA_LED`) stayed `excstate: started` throughout. This is the entire premise
   the design depends on, and it's real.
2. **RWS cannot create a new RAPID task — confirmed thoroughly, not assumed.** `GET
   /rw/cfg/sys/CAB_TASKS/attributes` gives the full schema (17 attrs, none mandatory, `Type`
   even defaults to `SEMISTATIC` already) and `OPTIONS` on the instances resource reports
   `Allow: GET,POST,DELETE,OPTIONS` — looked exactly like the "Allow header is right, wrong URL
   shape" pattern already solved for `loadmod`/`/set-value` elsewhere in this project. It
   wasn't: 4 variants (plain POST, `hal+json` Accept, `?action=add`, type-level
   `?action=create-instance`) all gave a clean, consistent `405`, zero side effects each time.
   RobotStudio's Task-configuration UI + a controller restart remains the only path. Don't
   re-attempt this without a new, concrete reason to believe it's changed.
3. **A new task's `TrustLevel` defaults to `SysFail`** (same as `T_ROB1`'s real motion task) —
   caught by reading the schema before it became a live incident. `T_GOFA_LED` itself reports
   `trust="None"` at runtime, so that's the value actually used, set on `T_LED` too (user
   confirmed via `GET /rw/rapid/tasks/T_LED` showing `trust="None"` after setup).
4. **Full end-to-end live verification, including physical confirmation**: stop `T_ROB1` → LED
   cyan → LED white flash → LED cyan → restart `T_ROB1` → LED reset to green, run start to
   finish against the real robot. User visually confirmed the light actually changed (solid
   red, then solid green) — not just API acks or RWS signal read-backs.
5. **A "LED stuck at solid green, no color change" report during this same session was a false
   alarm** — an automated test cycled colors and called `resetled` within ~2 seconds with no
   pause, so by the time it was checked visually the light had already settled back to green.
   Slowing down with explicit pauses confirmed every color change was real. Same lesson as
   [[feedback_ambiguous_hardware_test_result]] — verify live state / ask for exact timing before
   concluding a mechanism itself is broken.

**Node-RED side**: `gofa-robot.js`'s `socketSend(cmd, port)` now takes an optional port
override; new `ledPort` config field (default 1026). `gofa-asi-led` gained a third Transport
option, `'background'`. `teach_workflow_flow.json`'s three LED nodes use it. `check-status.js
--full` now lists all RAPID tasks, not just `T_ROB1` (useful for verifying `T_LED`'s state).
Found and fixed a real gap while committing: `.gitignore` only whitelisted the two existing
`.mod` files by name, so `BackgroundLed.mod` was silently excluded from git entirely.

6. **Real bug found and fixed while testing the actual deployed flow (not just raw scripts):
   a shared-session-cookie race in `gofa-robot.js`.** Two `gofa-subscribe-io` nodes sharing one
   `gofa-robot` config node (the teach workflow's Button 1 and Button 2 watchers) both start
   their WS subscriptions within the same ~0.5s window. OmniCore reissues `Set-Cookie` on many
   responses, and the old code re-fetched the cookie via a separate `robot.getCookie()` call
   *after* the subscribe POST resolved — if the other node's concurrent request overwrote the
   shared cookie variable in between, the WS upgrade used the wrong session and OmniCore
   rejected it with `WebSocket upgrade rejected: HTTP 500` (confirmed live, alternating between
   which of the two nodes failed each redeploy — a genuine race, not deterministic). **Fix**:
   `requestRawOnce` now captures the cookie synchronously in its own response callback and
   returns it as `res.cookie`, so callers use the cookie from their own response instead of a
   racy shared-state re-read. Same bug existed identically in `gofa-subscribe-elog.js` and
   `gofa-subscribe-state.js` (same pattern, `feedback_grep_all_nodes_after_shared_internals_refactor`
   applies) — fixed all three. Regression test added:
   `createRobotClient: requestRaw resolves with the cookie from ITS OWN response, immune to a
   concurrent request overwriting the shared session cookie`.
7. **Confirmed against the real, deployed `teach_workflow_flow.json`**, physical buttons pressed
   live (not simulated): full cycle including two real point saves, both LED cues, teach mode
   exit — all worked. Along the way, discovered **ABB's own safety controller drives the
   physical LED through states that override `gofa-asi-led` entirely, and this is correct
   behavior, not a bug**: solid **white** for ~3s while lead-through is activating/negotiating
   (RWS can report `Active` slightly before this settles), solid **yellow** instantly and only
   while the robot is *actually moving* (confirmed by moving the arm and watching it change in
   real time; the underlying `Asi1LedRed/Green/Blue` signal values were unaffected throughout —
   the override happens at the hardware level, `setled` still acks `OK` even while yellow is
   showing), and our own custom color only visible during genuinely idle/stationary moments.
   Practical implication documented in `CLAUDE.md`: don't design around cyan being continuously
   visible through an active lead-through session — treat it as an "idle within the session"
   indicator only. The point-saved white-flash works reliably because saving naturally happens
   while the arm is stationary.

Full technical detail, the RobotStudio one-time setup steps, and the live-test evidence are in
`CLAUDE.md`'s "Background LED task" section and the `omnicore-c30` skill's task-inventory table
— both committed to the repo, not just this memory.

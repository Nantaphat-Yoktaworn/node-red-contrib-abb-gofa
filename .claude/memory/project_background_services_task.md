---
name: project-background-services-task
description: "Generalized BackgroundLed.mod/T_LED into a background-services task (2026-07-17, per ideas/background-services-task-plan.md): setdo added, gofa-do-write/-connection-status/-egm updated, ledPort renamed backgroundPort. FULLY IMPLEMENTED, UNIT-TESTED (270/270), AND LIVE-VERIFIED END-TO-END INCLUDING THE EGM TEST — plan is 100% complete, ready to commit. Also found+fixed a real bug live: gofa-egm's stop() had no fallback when RWS rejects the graceful-stop signal write, which can strand an active EGM session with no recovery"
metadata:
  node_type: memory
  type: project
  originSessionId: 89dfabe3-80d8-495a-9391-c191673a3f34
---

Follow-on to [[project_background_led_task]] — implements `ideas/background-services-task-plan.md`
(saved 2026-07-17, same day as the original `BackgroundLed.mod`/`T_LED` work). Full narrative and
per-file design detail, including the exact reload procedure, is in `CLAUDE.md`'s "Background LED
task" section (the "Generalized to a background-services task" sub-section) — this memory is the
live-test status snapshot plus the two findings not obvious from the code alone.

## What changed

- `rapid/BackgroundLed.mod` gained a `setdo` case in `DispatchJson`, copying `MainModule.mod`'s
  `TrySetDo` allow-list (`ABB_SCALABLE_IO_0_DO1`..`DO16`, case-sensitive all-caps) verbatim, plus
  the `GetJsonNumVal`/`CleanCmd` helpers it needed (module can't share PROCs across tasks).
- `gofa-robot`'s config field renamed `ledPort` → `backgroundPort` (same port, 1026, no
  controller-side change) — grepped clean across `nodes/`, `.html`, `test.js`.
- `gofa-do-write` gained a third **Background task** transport (same `setdo` mechanism as Socket,
  routed to `robot.backgroundPort`).
- `gofa-connection-status` gained a third independent check, `msg.payload.background` — pings
  `robot.backgroundPort` so `socket.ok=false && background.ok=true` now distinguishes "T_ROB1
  specifically stopped" from "whole controller unreachable". Overall `ok` semantics unchanged
  (still `rwsOk && socket.ok` — background is diagnostic, not a health requirement).
- `gofa-egm` sets the ASI LED to magenta `[255,0,255,0]` via the Background transport once a
  session starts streaming, resets to green on `stop` — best-effort, fire-and-forget, never
  blocks/fails start or stop (mirrors the EGM-also-closes-T_ROB1's-socket root cause the original
  LED task was built for).
- PERS variable read/write via the background task stayed **explicitly out of scope** — cross-task
  PERS visibility is unconfirmed and needs its own investigation; digital I/O doesn't have this
  problem (global/task-independent by RAPID's I/O model).

## Live-test status — everything in the plan's verification list is done except the EGM LED step

**Session 1 (user away): confirmed everything automatable without touching the FlexPendant.**
- Both sockets reachable (`T_ROB1` 1025, `T_LED` 1026).
- `gofa-connection-status` (real node) 3-way check live-verified: stopped `T_ROB1` via the real
  `gofa-rapid-exec` node → got `socket.ok:false` + `background.ok:true` in one response, then
  cleanly restarted. This is the exact distinguishing behavior the feature exists for.
- Confirmed `setdo` over the background port genuinely didn't work against the **old** module
  (`ERR:SETDO`) — proved the reload was actually necessary, not a formality.
- Uploaded the new `BackgroundLed.mod` to `$HOME/Programs/` — succeeded (file transfer doesn't
  need the task stopped, only *loading* it into the running task does).
- `loadmod` attempt via RWS `403`'d as expected/documented (`T_LED` still `started`, no RWS path
  exists to stop an individual task — see [[project_background_led_task]] finding #2).

**Session 2 (user back): completed the reload live, including the one genuinely new discovery
this whole feature was blocked on.** Full procedure now in `CLAUDE.md`'s "Reload procedure"
bullet — summary of what's *not* obvious from the RWS API surface alone:

1. **There is no way to stop a `SEMISTATIC` task — RWS, RobotStudio, or FlexPendant — unless a
   specific FlexPendant setting is enabled first.** User found it: FlexPendant → **Execution
   menu** → checkbox **"Handle static and semi-static tasks the same way as normal task
   regarding start/stop."** With it off, `T_LED` simply isn't part of any Stop action anywhere.
   This setting is **only available/toggleable in Manual mode** — blocked in Auto.
2. Once checked, a normal **Stop** on the FlexPendant stops `T_ROB1` and `T_LED` together —
   confirmed via `GET /rw/rapid/tasks/T_LED` → `excstate: stopped`.
3. **RWS `loadmod`/mastership is still blocked at this point, for a different reason**: with the
   FlexPendant actively driving the controller, `GET /rw/mastership/edit` shows edit mastership
   held locally by `location: FlexPendant device`, `application: TPU` — an external RWS
   mastership request gets `403 "Requested resource is held by someone else"`. Also, RWS edit
   mastership itself was found to require Auto mode, which would undo the stop from step 2 by
   restarting both tasks (since the checkbox makes a plain Start bring `T_LED` back up too).
   **Net effect: this reload cannot be driven over RWS at all while using this method** — the
   fix was loading the module directly through the FlexPendant's own Program Editor (task
   selector → switch to `T_LED` → File → Load Module → `$HOME/Programs/BackgroundLed.mod` →
   Replace). The file itself was still uploaded via ordinary RWS `fileservice PUT` beforehand —
   only the load-into-task step needed the FlexPendant.
4. Verified the reload actually took **over RWS**, without needing the FlexPendant again: `GET
   /rw/rapid/tasks/T_LED/modules/BackgroundLed/text` returns a fileservice reference
   (`file-path`, not the text — same indirection as the module-text-fallback note elsewhere in
   this project), and a follow-up `GET` on that path returned the new source byte-for-byte,
   confirmed against the repo copy including the new `setdo` case and its helpers.
5. Restarted both tasks, then **unchecked the Execution-menu setting again** — critical, since
   leaving it on means every ordinary future RAPID stop (teach workflow included) also stops
   `T_LED`, defeating its entire purpose.
6. **Final live verification, both raw and through the real node file:** `setdo` on
   `ABB_SCALABLE_IO_0_DO1` via the background port (1026) flips `0→1→0`, independently
   cross-checked with an RWS `lvalue` read after each step — both via a raw `socketSend` call
   and via actually driving the real `gofa-do-write.js` node (Background transport) with a
   throwaway harness copying `test.js`'s `loadNodeType`/`runInput` pattern. Robot left healthy
   (`motoron`/`AUTO`/`running`/100%) throughout and at the end.

## Session 3 (user back, requested EGM test before commit) — plan is now 100% complete

Swapped `T_ROB1` to `MainModuleEGM.mod` via the real `gofa-setup` node (module: `MainModuleEGM`).
Hit two live snags, both diagnosed and fixed, before the actual test passed clean:

1. **Self-inflicted**: my first `gofa-setup` run used a throwaway `createRobotClient()` object
   that never set `.ip` — `patchServerIp(content, undefined)` still matches and injects, so it
   literally wrote `CONST string SERVER_IP := "undefined";` into the uploaded module, silently
   breaking the socket. Fixed by setting `client.ip` explicitly; re-ran the swap cleanly.
2. **Real, pre-existing bug, not self-inflicted**: `EGM_PC`'s `RemoteAddress` (the UDPUC
   transmission-protocol config EGM needs) was stale (`192.168.1.101`, not this host's real
   `192.168.1.104`) — the user's first attempt to fix it landed in the wrong RWS config domain
   (`EIO`, confirmed via elog) instead of the `SIO` domain `EGM_PC` actually lives in
   (`GET /rw/cfg/SIO/UDPUC_HOST/instances/EGM_PC` — found live by listing all 6 domains this
   controller exposes; full detail in `CLAUDE.md`). This left `T_ROB1` genuinely stuck in
   `EGMSetupUC` with no self-recovery (matches this project's own documented "no natural
   timeout" finding). **Side effect of that same wrong-domain change**: `ABB_Scalable_IO_0_DO16`
   (the EGM graceful-stop signal) had its Access Level revert from `All` to `Default`, so once
   the user fixed `EGM_PC` properly and the retry ran, `gofa-egm`'s `stop()` got a `403` trying
   to write that signal over RWS — stranding the session again, this time recovered manually via
   a raw `setdo` over the background port (proving live that the just-built background-task
   `setdo` capability is genuinely useful beyond its original LED/do-write scope).

**Fixed properly, not just worked around**: added `setStopSignal()` to `gofa-egm.js` — tries the
RWS write first, falls back to the background-task `setdo` (same signal, upper-cased name) if
RWS rejects it. Used at all three call sites (`start()`'s orphan-cleanup, `stop()`'s main write,
`stop()`'s reset-to-0 cleanup). New unit test:
`gofa-egm: "stop" falls back to the background transport if RWS rejects the stop-signal write`.
270/270 tests pass.

**Confirmed live, clean run, end to end, both by telemetry and by the user physically watching**:
`gofa-egm` `start` → baseline held → `gofa-egm-move` +3° on joint 6 → telemetry showed real
convergence (`3.40° → 6.40°`, `convergence:true`) → back to baseline (converged again) → `stop`
completed via the code path with no manual intervention. User independently confirmed: arm
visibly moved and returned, LED went magenta while streaming and green after stop.
`T_ROB1` swapped back to `MainModule.mod` afterward (also via the real `gofa-setup` node) —
robot ended on the normal default module, fully healthy.

**Nothing in the codebase is still pending.** All 5 plan changes done, all unit-tested, all
live-verified including the one bug this session's own testing surfaced and fixed. Ready to
commit.

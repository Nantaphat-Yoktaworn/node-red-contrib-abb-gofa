---
name: project_module_version_handshake_watchdog
description: "Module version handshake + self-healing watchdog flow — both shipped and live-verified 2026-07-20, bumped to 2.4.0"
metadata: 
  node_type: memory
  type: project
  originSessionId: f19b26e2-3fa2-4d0e-9cd8-e68bc97a7910
---

Implemented improvement-roadmap.md items #1 (module version handshake) and #2 (self-healing
watchdog flow) in one session, 2026-07-20. Bumped package.json + all three `.mod` files'
`MODULE_VERSION` to `2.4.0` in lockstep.

**Why now**: user asked to start on this pair specifically, staged the robot in Auto mode /
motors off / RAPID stopped for safe live-testing, and asked to use `agy` for delegation.

**What shipped**:
- RAPID: `CONST string MODULE_VERSION` in `MainModule.mod`/`MainModuleEGM.mod`/`BackgroundLed.mod`,
  included in the `ping` JSON reply.
- `gofa-robot.js`: `socketSend()` records the reported version per-port as a side effect;
  `getLastPingVersion(port)` (default = main T_ROB1 port) on both the raw client and
  `GoFaRobotNode`; `PALETTE_VERSION` exported, read live from `package.json`.
- `gofa-connection-status.js`: `msg.payload.moduleVersion.{socket,background}` = `{version,
  status}`, status `match`/`mismatch`/`unknown`; yellow node status on an otherwise-healthy
  mismatch.
- `gofa-setup.js`: final `socket PING` step's `detail` reports the same comparison
  (informational only, never fails the step).
- New `flows/watchdog_flow.json`: 30s timer → reentrancy guard → `gofa-connection-status` →
  wedge check (`rws.rapid === 'running' && socket.ok === false` — NOT just "socket down", which
  is also the normal legitimate-stop signature) → evidence capture (`gofa-elog` then
  `gofa-rapid-tasks`) → `stop`→`resetpp`→`start` (change-node payload clears between each) →
  re-check → notify (`debug` node).
- Full writeup in `CLAUDE.md`'s "Module version handshake + watchdog flow" section.

**Delegation to agy (Gemini 3.1 Pro High, advisory-only, no worktree)**: two parallel background
tasks — (a) draft the `moduleVersion` reporting code for `gofa-connection-status.js`/
`gofa-setup.js` + tests, (b) draft `watchdog_flow.json`. Both landed genuinely good work overall,
but **two real bugs surfaced during review, neither from agy's core logic**:
1. **Claude's own transcription bug**, not agy's: when hand-applying agy's text output via the
   Write tool, mistyped `waitFor(readExec, 'running', timings.start, 'RAPID')` as
   `waitForExecState('running', timings.start)` in `gofa-setup.js`'s admin-endpoint copy —
   would have been a `ReferenceError` on every live `/gofa-setup/:id/start` admin call. Caught
   by a `node -c` syntax check + `require()` smoke test before running the test suite, not by
   the test suite itself (the admin-endpoint code paths aren't unit-tested — see the
   `feedback_agy_advisory_output_needs_line_by_line_apply` lesson this reinforces: even
   *transcribing* agy's output by hand needs the same "don't trust, verify" discipline as
   trusting agy's own edits directly).
2. **A real design bug in the watchdog flow draft**: agy's `watchdog_flow.json` fanned the
   evidence-capture step (`gofa-elog` + `gofa-rapid-tasks`) out in parallel with both branches
   converging onto the same next node (`Stop RAPID`) — meaning two independent messages would
   each traverse the ENTIRE recovery chain (stop→resetpp→start→recheck→notify) once wedge
   detection fired, double-running every recovery action. My own task brief invited this (I
   suggested the fan-out/converge shape and only flagged it as a "best-effort, don't worry about
   sync" concern, missing that converging two upstream wires into one downstream node in Node-RED
   means two separate message flows, not one shared flow). Fixed by making evidence capture
   sequential (elog → stash → rapid-tasks → stash → stop) instead — caught via manual structural
   validation (counting incoming wires to the `Stop RAPID` node) before ever touching real
   hardware, not live.

**Live-tested against 192.168.1.103** (RobotWare 7.21.0+229) via a fake-RED harness pointed at
the real robot (same pattern `test.js` uses for mocks, just wired to
`createRobotClient()`+real creds instead) — driving the actual node files, not curl or a
reimplementation:
- `moduleVersion` status `'unknown'` confirmed against the pre-upgrade `BackgroundLed.mod`
  (ping succeeds, no version field) AND against T_ROB1 with RAPID stopped (ping itself fails).
- Wedge-detector confirmed `false` (no false positive) while RAPID was legitimately stopped.
- Ran real `gofa-setup` end-to-end: uploaded new `MainModule.mod`, loaded, motors on, started —
  final step reported `"OK (module v2.4.0)"`, the match case confirmed on fresh real hardware.
- Re-ran `gofa-connection-status`: `socket.status` now `'match'`, `background.status` still
  `'unknown'` (BackgroundLed.mod/T_LED not reloaded — needs the manual FlexPendant procedure,
  out of scope this session).
- Drove the real recovery chain (`gofa-rapid-exec` stop→resetpp→start with cleared payloads
  between, exactly the flow's wiring) live: zero chaining-hazard warnings, clean
  `running`/`motoron` end state.

**Not live-tested**: the watchdog flow's actual trigger path (switch → evidence → recovery)
end-to-end, since deliberately reproducing the real (still-unexplained) socket wedge on live
hardware risks the exact failure mode this feature exists to recover from. Decision logic and
recovery mechanics were each verified live independently instead — reasonable coverage, but the
first real wedge this flow handles is still the first real end-to-end proof.

**Also not done**: `BackgroundLed.mod`'s own version bump is code-complete but unverified live
(needs a T_LED reload via the documented FlexPendant procedure — see
[[project_background_led_task]]).

Robot end state after this session: motors ON, RAPID running, MainModule v2.4.0 loaded — a
normal healthy resting state, not reverted.

**Follow-up fix same day (2026-07-20), found via user's real usage**: user deployed and manually
ran the flow; a real, unrelated safety-guard-stop happened near-simultaneously (user was
physically near the robot, tripping the enabling device/guard — confirmed by asking, not
assumed) with error codes 71058 ("Lost communication with I/O device") and 36619
("Communication issue with the Robot Signal Exchange Proxy") — both hardware/safety-fieldbus
layer, unrelated to RWS/RAPID and not this feature's fault. Recovered manually (motors on →
resetpp → start via the real node code, live-confirmed healthy after).

While explaining why teach-workflow doesn't interfere with the watchdog, re-checking the wedge
condition against `gofa-egm` surfaced a real bug in what had just shipped: an active EGM session
deliberately keeps `rws.rapid` at `'running'` for its whole duration (per the TRAP/`EGMStop`
design) while closing T_ROB1's socket — indistinguishable from a genuine wedge under the
original condition. The CLAUDE.md section I'd just written had actually gotten this wrong too,
listing EGM sessions as "a legitimate stop" alongside teach workflow — they're not (teach
workflow genuinely sets `rapid: 'stopped'`; EGM doesn't). Fixed: `gofa-connection-status` now
reports `egmActive: !!r._egmActive` (cheap, no new calls), watchdog's wedge condition gained
`&& !egmActive`. Unit-tested against the exact EGM shape; `egmActive: false` live-confirmed
against the real robot's normal state (the `true` case not forced live — needs
`MainModuleEGM.mod` loaded + a real session, judged out of scope for this fix).

See also: [[project_background_services_task]] for the diagnostic groundwork this built on,
[[project_socket_server_stuck_2026-07-15]] for the original unresolved wedge bug this targets,
and [[project_background_led_task]] for the subsequent chaining-hazard and lead-through-timeout
fixes found the same day while using this feature.

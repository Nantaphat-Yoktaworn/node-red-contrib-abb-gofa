---
name: project_autonomous_sequence_feature
description: "Standalone RAPID sequence-runner feature (AutoSequence.mod) — goal, key decisions, plan location, progress"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b4c0b98-980a-4dc2-b1a3-6218ede82b8f
---

User wants the robot to run a saved-point sequence **fully standalone** (no Node-RED at
runtime) — started/stopped/paused by physical I/O and a native FlexPendant UI, with the point
list and per-step delay editable directly on the FlexPendant (no regeneration round-trip through
Node-RED needed for day-to-day edits).

Full approved plan is at `C:\Users\RD2\.claude\plans\concurrent-kindling-valley.md` — read it
for the complete design (architecture, RAPID module structure, Node-RED node changes, phased
verification spikes). Key decisions locked in during planning:
- Fully takes over the task (mutually exclusive with the Node-RED socket server — only one task
  can drive `ROB_1`).
- Deployed as a **separate module file** `AutoSequence.mod` (not a same-name replace of
  `MainModule.mod`).
- Control is a **mix**: ASI buttons + DSQC1030 DI + on-screen FlexPendant buttons, all live.
- Physical-button Start is deterministic (resume if paused, else restart from step 1); on-screen
  Start can interactively ask Restart-vs-Resume via `UIMsgBox` since a human is present to answer.
- Pause is **graceful/between-points** (not mid-move) — this was the recommended default; the
  user never directly confirmed it (got redirected into the FlexPendant-UI idea instead), so
  revisit if mid-move pause turns out to matter.
- Point list lives in a flat RAPID-native data file (`SEQ_FILE`, same idiom as `MainModule.mod`'s
  `HOME_FILE` persistence), not baked as RAPID `CONST`s — required so the FlexPendant edit menu
  can append/remove without recompiling anything.

**Why this shape**: baking points as compile-time `CONST robtarget`s (the original idea before
the FlexPendant-UI ask came up) would have blocked runtime editing entirely — switching to a
file-backed array was the one design change that satisfied both "seed it from Node-RED" and
"edit it standalone on the pendant" at once.

**Dashboard detour**: the user asked for a persistent FlexPendant dashboard (like the built-in
jogging/production screens) instead of sequential popups. Investigated the OmniCore App SDK /
AppStudio path — free, no RobotWare license gate, but actually getting a custom app to launch on
the FlexPendant needs RobotStudio + the AppStudio add-in (a GUI install/registration step,
confirmed not achievable via raw `fileservice` file placement — see
[[reference_omnicore_appstudio_investigation]]). Ruled out for breaking this project's
everything-scriptable-via-RWS pattern. **Final decision: back to the RAPID-native `TPReadFK`/
`UIMsgBox`/`UINumEntry` menu**, confirmed working live.

**Status: feature complete and merged to main.** Branch `autonomous-sequence` was committed
(`903c6dc`) and the work is done for this session. Confirmed live end-to-end on RobotWare
7.21.0+229:
- Full deploy chain via the real Node-RED nodes (not just curl): `gofa-gen-sequence-data` →
  `gofa-upload-mod` (new direct-content-payload path) → `gofa-rapid-exec`'s new `unloadmod`
  action → `loadmod`/`activate`/`resetpp`/`start`.
- On-screen Start → real motion through the full seeded sequence, looping.
- Physical Stop (`Asi1Button2`) → immediate halt → on-screen menu correctly reappears.
- Physical Start (`Asi1Button1`) was **deliberately removed** per the user's request (on-screen
  Start only now) — see `rapid/AutoSequence.mod`'s header comment.
- **Not exercised live**: Pause via `ABB_Scalable_IO_0_DI1` (no physical wiring available, and
  the only available way to simulate it requires Manual mode, which itself stops RAPID/cuts
  motors and confounds the test — see the mode-switch note below), the Restart-vs-Resume
  on-screen dialog (needs a paused/faulted state to reach), and the Manual-mode Add/Remove/
  Edit-Delay menu. Implementation is present and code-reviewed but genuinely untested for these
  three.
- Fixed 7 real bugs live along the way (all now in the `abb-rws` skill's new "RAPID Language
  Gotchas" section — read that before writing RAPID interrupt/TP-UI code again): missing PERS
  array initializers, a `CONST zonedata := z10` alias, `ReadStr`'s `EOF`-is-a-value-not-an-error
  behavior (infinite loop), `StopMove \Quick` unsupported on this controller despite being in
  ABB's docs, needing `ExitCycle` (not just `StopMove`/`ClearPath`) to safely stop from a `TRAP`
  without hanging, `ERR_ALRDYCNT` from re-`CONNECT`ing interrupts across an `ExitCycle` restart,
  and `btnres` vs `buttondata` constant mixups (`resOK`/`resCancel` for `\Result`, not
  `btnOK`/`btnCancel`).
- **Switching the controller's opmode from Auto to Manual stops RAPID execution and cuts motors
  outright** — confirmed live, not something `AutoSequence.mod` does. Relevant any time a live
  test plan involves toggling opmode while something is running.
- Robot restored to normal `MainModule.mod`/Node-RED control and the Teach Workflow flow
  re-enabled before wrap-up.

Robot IP keeps drifting within the same day (`.33` doc default → `.36` → `.15` on 2026-07-07) —
see [[reference_robot_ip_drift]] if that memory exists, otherwise just always re-check with
`/robot-status` rather than trusting a recorded IP.

---
name: project_conc_queue_depth_crash_fix
description: "RAPID error 40631 (chained \\Conc moves crash T_ROB1) root-caused and fixed 2026-07-20, bumped to 2.4.2 - \\Conc removed from HOME/GOTOJ/GOTOL/MOVEJ/MOVEL"
metadata: 
  node_type: memory
  type: project
  originSessionId: e97b9385-aeeb-4c38-804b-7073e2fd303f
---

Fixed live 2026-07-20, committed 32ecbd4, pushed to main. User reported `pickplace_sorting_flow.json` worked once then RAPID error **40631** ("Too many move instructions in sequence with concurrent RAPID program execution") on the second cycle, stopping T_ROB1 and its socket server (needed a full `gofa-setup` redeploy to recover, not just `resetpp`).

**Root cause**: every chained motion instruction (`HOME`, `GOTOJ`/`GOTOL`, `MOVEJ`/`MOVEL`) used `\Conc` so the ack could return before the physical move finished. A helper `PROC AddConcMove()` was meant to call `WaitRob \InPos` periodically to stay under RAPID's advance-run `\Conc` queue-depth limit.

**Five independent live-tested fixes all failed at the identical move** regardless of the variable changed:
1. Added the missing `AddConcMove` call to `rGoHome` (the one site skipping it) — failed at move 5.
2. Fixed its zone (`z50`→`fine`, needed for `WaitRob \InPos` to detect a real stop) — pushed failure to move 7.
3. Fixed a genuine off-by-one in `AddConcMove`'s counter reset — zero effect (expected, only matters on the 2nd sync).
4. Synced on literally every move (no threshold) — still failed at move 7/8.
5. agy's ABB-informed fix (`WaitTime 0.1` before `WaitRob \InPos`, to dodge an InPos-latency race) — still failed at move 7.

Also tested: 5mm moves between two points sharing an identical `robconf` (ruled out kinematics/singularity), and request pacing from 0s to 4s apart (ruled out a client-side race). The failure point was **count-based, not time-based or distance-based** — same result every time regardless of these variables. That level of consistency across 5 structurally different sync strategies is what proved `WaitRob \InPos` called from a helper `PROC` simply wasn't resetting whatever RAPID actually tracks — not a tuning problem, a design dead end.

**The fix that worked, confirmed live (20/20 clean cycles vs. 100% failure by move 7 before)**: removed `\Conc` entirely from `rGoHome`, `TryGoTo`, `TryMoveJ`, and the JSON `goto`/`movej`/`movel` handlers, in both `MainModule.mod` and `MainModuleEGM.mod`. Ack is already sent before the move runs, so this is invisible to Node-RED — RAPID just finishes each move before serving the next socket command. Deleted the now-fully-unused `AddConcMove`/`concCount` machinery. Jog commands (cartesian/joint jog, JSON `jog`/`jointjog`) were untouched — each already does a full `StopMove`/`ClearPath`/`StartMove` reset before its own single `\Conc` move, never exposed to this bug.

**Trade-off deliberately accepted (user chose "apply everywhere" over a narrower fix or keeping `\Conc`)**: `STOP`/`gofa-stop-motion` can no longer interrupt an already-executing `HOME`/`GOTOJ`/`GOTOL`/`MOVEJ`/`MOVEL` — only cancels a queued one, taking effect once the current move finishes. Safety controller's hardware e-stop is independent of this software layer either way.

Bumped `MODULE_VERSION` in all three `.mod` files (including `BackgroundLed.mod`, whose own content didn't change — it tracks the palette version as one number for drift detection, not its own history) and `package.json` to **2.4.2**. Docs updated: CLAUDE.md (new dated note + STOP table row + ack/error-handler line), both READMEs, MANUAL_CONTROL.md.

**Methodology lesson** (see [[feedback_agy_advisory_output_needs_line_by_line_apply]] for a related one): when N structurally-different mitigations to the same subsystem all fail at the *identical* point, stop tuning that subsystem and question whether the mechanism itself is sound. Don't keep adjusting thresholds/timing on a synchronization primitive that's already been tested at its most aggressive setting (sync-every-call) and still failed — that's the signal the primitive itself is the problem, not its parameters.

**Process note**: mid-investigation the user tightened live-test constraints ("no more than 1cm movement") after burning several full-task-crash cycles; I initially re-ran a stale test script that used the old large-distance points before catching and disclosing the mistake. Built `TinyA`/`TinyB` test points (≤5mm from current position) to keep testing safely within the constraint — this is a reusable pattern for constrained live robot testing (derive test points from current live pose + tiny offset, don't reuse arbitrary saved points that may be far away).

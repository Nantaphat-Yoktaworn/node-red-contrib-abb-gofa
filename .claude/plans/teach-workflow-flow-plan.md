# Plan: Standalone "Teach Workflow" flow — physical-button controlled, safety-gated

## Context

The previous session built a simple demo (in `flows/gofa_demo_flow.json`) proving that
pressing either ASI arm button (`Asi1Button1`/`Asi1Button2`) can drive a Node-RED flow via a
real WebSocket push (after fixing a bug in `gofa-subscribe-io`), and wired it straight to
`gofa-save-point` as a proof of concept.

The user now wants the real version of this, with real state semantics, and wants it removed
from the demo flow and shipped as its own file:

- Starting precondition: robot already in **Auto mode, Motors On, RAPID running** (this flow
  doesn't set that up — it assumes it).
- **Press ASI Button 1** (1st time): stop RAPID execution → enable lead-through (hand-guiding).
- User hand-guides the arm.
- **Press ASI Button 2** (any time while lead-through is active): save current pose as a new
  point.
- **Press ASI Button 1** (2nd time): disable lead-through → reset program pointer → restart
  RAPID — restoring the exact state from before the first press.

The user explicitly asked for: reuse of existing palette nodes over a `function` node wherever
possible; explicit checking of *live* robot state (not an internal flag) to decide 1st-vs-2nd
press, plus general bug-prevention; the flow in its own file, not the demo flow.

A Plan subagent worked out the full node topology reusing `gofa-status`, `gofa-rapid-exec`,
`gofa-subscribe-io`, `gofa-leadthrough-enable/disable`, and `gofa-save-point`, gated with core
`switch`/`delay`/`change` nodes. One open point from that design — how to bridge the gap between
`gofa-rapid-exec`'s `stop` action (which doesn't confirm RAPID actually finished stopping) and
`gofa-leadthrough-enable` (which requires RAPID to already be stopped) — the user chose the most
robust option: actively poll until confirmed stopped, with a bounded retry. Working through it
further: this is fully buildable with **zero function nodes** (a `change` node can increment a
retry counter via a JSONata expression just as well as a function node could), improving on the
subagent's fallback suggestion of allowing one function node there. Final design below uses no
function nodes anywhere.

## Files to change

### 1. `flows/gofa_demo_flow.json` — remove the old teach-workflow group

Delete the group node `548fe709a4f6006f` ("Teach Workflow (Physical Button → Save Point)") and
its 7 member nodes (comment, inject, 2×`gofa-subscribe-io`, `function` filter, `gofa-save-point`,
`debug`) added in commit `88ad86d`. This group's naive "either button saves unconditionally"
behavior is superseded by the new file and would otherwise fire simultaneously with it if both
are deployed. No other part of this file changes.

### 2. `flows/teach_workflow_flow.json` — new file

Self-contained: own `tab`, own copy of the `gofa-robot` config node (`id: "cfg1"`, same fields as
the demo flow's — Node-RED de-dupes by id on import into an already-running instance, so this is
safe even if the demo flow's `cfg1` is already deployed). Two groups, no `function` nodes
anywhere — only real `gofa-*` nodes plus core `switch`/`delay`/`change`/`inject`/`debug`.

**Group A — "Button 1: Toggle Teach Mode"**

1. `inject` (`once:true`, `onceDelay:0.5`) → starts the persistent subscription once on deploy.
2. `gofa-subscribe-io` (`signal:"Asi1Button1"`, `oneshot:false`) — real WS push per press/release.
3. `switch` — rising edge only: rule `payload.value == 1` (number), single output (the `value:0`
   release matches nothing and is dropped — no function node needed).
4. `delay` (rate-limit mode, 1 msg / 4s, drop intermediate) — debounces a fast double-tap.
5. `gofa-status` — live read of `{ctrlstate, opmode, speed, rapid}`; fan out to a `debug`
   ("Button1: Live State") in parallel with the routing switch below, so the exact state is
   always visible for diagnosis regardless of which branch fires.
6. `switch` with JSONata rules, **3 outputs**:
   - Rule 1 (start teaching): `payload.rapid = "running" and payload.opmode = "auto" and payload.ctrlstate = "motoron"`
   - Rule 2 (finish teaching): `payload.rapid = "stopped"`
   - `otherwise` (unexpected state, e.g. manual mode or motors off): routed to a `change` node
     building `{ok:false, ignored:true, reason:"Unexpected state for teach toggle", ...state}`
     → `debug` ("Button1: Ignored — unexpected state"). (This adds symmetry with Button 2's
     explicit ignore-message, improving on the subagent's version which left this branch bare.)

   **Start-teaching branch (Rule 1):**
   7. `gofa-rapid-exec` (`action:"stop"`) — fan out to `debug` ("Button1: Stop RAPID Result").
   8. `switch` on `payload.ok == true` — only the true output is wired onward (a failed stop
      must not proceed into lead-through).
   9. `change` — initialize `msg.retryCount` to `0`.
   10. `gofa-status` (dedicated instance for this loop, distinct from step 5) — reads live state.
   11. `switch` — rule `payload.rapid == "stopped"` → proceed (out1); `otherwise` → out2.
       - out1 → `gofa-leadthrough-enable` → fan out to `debug` ("Button1: Lead-through Enable
         Result") — terminal; a failure here just means the operator presses Button 1 again.
       - out2 → `change` (`msg.retryCount` = JSONata `msg.retryCount + 1`) → `switch` (rule
         `msg.retryCount <= 5`): true → `delay` (fixed, 300ms) → loops back to node 10; false
         (retries exhausted, ~1.5s total — matching `gofa-rapid-exec`'s own internal 1.5s/300ms
         polling convention for `start`) → `debug` ("Button1: RAPID never reached stopped —
         giving up").

   **Finish-teaching branch (Rule 2):**
   12. `gofa-leadthrough-disable` — fan out to `debug` ("Button1: Disable Lead-through Result").
   13. `switch` on `payload.ok == true`, true-only wired onward.
   14. `gofa-rapid-exec` (`action:"resetpp"`) — fan out to `debug` ("Button1: Reset PP Result").
   15. `switch` on `payload.ok == true`, true-only wired onward — critical gate: never restart
       RAPID if the pointer reset failed.
   16. `gofa-rapid-exec` (`action:"start"`) — `debug` ("Button1: Restart RAPID Result"),
       terminal. (`gofa-rapid-exec`'s own `start` action already re-verifies motors-on and polls
       for `running`, so no extra gating needed here.)

**Group B — "Button 2: Save Point (gated on teach mode)"**

1. `inject` (`once:true`, `onceDelay:0.5`) → subscription starter.
2. `gofa-subscribe-io` (`signal:"Asi1Button2"`, `oneshot:false`).
3. `switch` — rising edge only, same pattern as Group A step 3.
4. `delay` (rate-limit, 1 msg / 2s, drop intermediate) — debounce.
5. `gofa-status` — fan out to `debug` ("Button2: Live State").
6. `switch` — rule `payload.rapid == "stopped"` (i.e. currently mid-teach) → out1; `otherwise` →
   out2.
   - out1 → `gofa-save-point` (`pointName:""`, auto-names "Point N") → `debug` ("Button2: Save
     Point Result").
   - out2 → `change` — builds `{ok:false, ignored:true, reason:"Not in teach mode — press
     Button 1 first", rapidState: payload.rapid}` → `debug` ("Button2: Ignored — not in teach
     mode").

Roughly ~40 nodes total including comments/config/tab — every step gated on the previous
step's success and visible in its own debug output; no silent failures, no unguarded cascades.

### 3. `README.md` and `CLAUDE.md` — mention the new file

Both currently list `flows/gofa_demo_flow.json` and `flows/dashboard_flow.json` in a repo-layout
listing (`README.md` lines ~11-13 and ~205-208; `CLAUDE.md`'s repo layout section at the bottom).
Add a one-line entry for `flows/teach_workflow_flow.json` in both places, plus a short paragraph
in README's flow-import section explaining the precondition (Auto/Motors-On/RAPID-running) and
that it's independent of the demo flow (separate tab, own `cfg1` copy — safe to import both, no
id conflict). Also check `.claude/commands/abb-rws.md` / `omnicore-c30.md` / the CLAUDE.md "ASI
buttons note" for any stale reference to the old demo-flow group by name — from what was written
they only describe the general capability, not the specific demo group, so likely no change
needed there, but worth a quick grep before finalizing.

## Verification

This flow does something materially riskier than the previous demo (it actually stops/restarts
RAPID and engages lead-through on a real robot with a person's hand on the arm), so verify in
two stages, per this project's "verify before/after building" convention:

1. **Logic verification via harness first** (before ever touching the real Node-RED editor):
   write a throwaway Node.js script — same technique used earlier this session for the
   `gofa-subscribe-io` fix and the first teach-workflow test — that `require()`s the real,
   unmodified `gofa-robot.js`, `gofa-status.js`, `gofa-rapid-exec.js`, `gofa-subscribe-io.js`,
   `gofa-leadthrough-enable.js`, `gofa-leadthrough-disable.js`, `gofa-save-point.js`, wires them
   in JS exactly matching the flow's sequencing/gating logic above (including the retry loop),
   and drives it against the live robot with real button presses — confirming: first Button 1
   press actually stops RAPID and engages lead-through (check via `gofa-status`/lead-through
   RWS status), Button 2 saves a real point mid-teach, Button 2 is correctly ignored outside
   teach mode, second Button 1 press disables lead-through/resets pp/restarts RAPID and
   `gofa-status` afterward shows `rapid:"running"` again. Delete the throwaway script and any
   test points-file afterward, same cleanup discipline as before.
2. **Real Node-RED import test**: import `teach_workflow_flow.json` into the user's actual
   Node-RED instance (delete the old demo-flow group first, or re-import the demo flow without
   it), re-enter the `cfg1` password, Deploy, click both "Start Watching" injects, and repeat the
   same live button-press walkthrough end-to-end watching the debug sidebar — this is the
   ground-truth test since it's the actual deployment path the user will use.

Both stages require the user to physically press the ASI buttons at the right moments, same
collaborative testing pattern used earlier this session.

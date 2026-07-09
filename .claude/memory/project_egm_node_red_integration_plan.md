---
name: project-egm-node-red-integration-plan
description: "EGM/UDP integration into the Node-RED palette — IMPLEMENTED, published (npm 1.1.0), all known bugs including the instance-leak RESOLVED; gofa-egm later split into gofa-egm (session control) + gofa-egm-move (movement, fallback output), also live-verified"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2fe0fd58-9b96-4052-b0d4-0f8dffaf0354
---

**Status: IMPLEMENTED, PUBLISHED, FULLY LIVE-VERIFIED — no known open bugs** (2026-07-09,
GoFa 12 / OmniCore C30, RobotWare 7.21.0+229; published to npm as
`node-red-contrib-abb-gofa@1.1.0` at the time, though the node split below post-dates that
publish and hasn't been republished yet — check `package.json`'s version against npm before
assuming it's live). `gofa-egm` + `rapid/MainModuleEGM.mod` (sibling clone of `MainModule.mod`,
not a merge), later split into `gofa-egm` (session control/telemetry) + `gofa-egm-move`
(movement, see the "Node split" entry below). Builds on [[project-gofa-egm-python]] (proven
working EGM joint streaming, in a separate repo).

**Note on the linked plan file**: `C:\Users\anapa\.claude\plans\federated-gliding-tulip.md` was
overwritten (2026-07-09, later session) with the node-split plan below, per plan-mode's
different-task rule — it no longer contains the original EGM build-out plan or its "Live
verification results" log. That history is preserved in full in `CLAUDE.md`'s EGM section
(the repo file, not this plan file) — treat CLAUDE.md as authoritative for pre-split history
from here on, not the plan file.

**The instance-leak bug (previously the one open limitation) is FIXED — found in ABB's own
docs, not guessed.** User provided a local copy of ABB's EGM Application Manual (3HAC073318,
converted to markdown, at `C:\Users\anapa\nnnn\note\`). It confirmed: (1) RobotWare allows max
**4** concurrent EGM identities (exactly matching the observed ~8-cycle failure threshold), and
(2) `EGMStop` is a real, documented instruction, explicitly meant to be called "in a TRAP
routine" to gracefully end a running `EGMRunJoint` — precisely the mechanism needed. **Implemented
and confirmed live**: `MainModuleEGM.mod` now has a `TRAP TrapEgmStop` (`EGMStop egmID1,
EGM_STOP_HOLD;`) wired via `CONNECT`/`ISignalDO` to `ABB_Scalable_IO_0_DO16`; `gofa-egm.js`'s
`stop()` now just sets that signal via RWS (`/set-value`) and polls `PING` for confirmation,
instead of the old external RWS task-kill. The RAPID task never actually stops anymore on a
normal `gofa-egm` cycle — confirmed via elog showing zero "Program stopped"/"Program started"
events across a full cycle. **12 consecutive start/stop cycles (1.5x the count that broke the
old design) all succeeded with stable ~80ms/~1050ms timing and zero errors.** `stop()` is also
simpler now — no longer needs `withMastership`/`rwsGet`/`parseXhtml`, just `rwsPost` +
`socketSend`.

**Lesson worth remembering**: two live-test sessions couldn't determine the real fix through
experimentation alone (a plausible-seeming `\CondTime` hypothesis was tested and disproven).
The vendor's own application manual answered it in five minutes once the user provided it. If
stuck on ABB-specific behavior after reasonable live experimentation, checking for the official
manual is worth doing before continuing to guess-and-test live.

**Other live corrections to the original design — all still relevant if this is touched
again:**

1. **Mode exit is NOT self-healing via `\CommTimeout`** (confirmed live: going quiet with a
   connected session left RAPID blocked for 2+ minutes, zero recovery). This is what motivated
   the original external-RWS-stop design (now superseded by the TRAP/`EGMStop` fix above for
   *normal* `gofa-egm` use) — but the underlying finding still matters for the narrower case of
   a **genuinely external** stop (FlexPendant, e-stop) interrupting a session, which the
   TRAP/`EGMStop` mechanism doesn't cover. `MainModuleEGM.mod`'s `bEgmRequested` flag is still
   cleared *before* calling `RunEgmJoint` (not after) for this reason — an external stop still
   skips the ERROR handler.
2. **Switching between `MainModule.mod`/`MainModuleEGM.mod` needs an explicit unload step.**
   `loadmod`'s `replace=true` only replaces a *same-named* module; loading a differently-named
   one while another is loaded leaves both loaded (both declare `PROC main()`) and RAPID
   rejects `resetpp`/`start` with `(87,5): Global routine name main ambiguous`. Fix: a new
   `unloadmod` action on `gofa-rapid-exec` (`POST /rw/rapid/tasks/{task}/unloadmod`, body
   `module=<name>`, hal+json + mastership like `loadmod`/`activate`). Swap sequence: `stop` →
   `unloadmod` (current module) → upload the other file → `loadmod` → `resetpp` → `start`.
3. **A bare "continue" RAPID start after an *external* EGM interruption re-enters EGM code.**
   If RAPID is ever stopped by something other than `gofa-egm.js` itself while a session is
   active, and then resumed with a plain "continue" start (not `resetpp` first), the program
   pointer can be left mid-EGM-code, re-entering EGM setup without `RunEgmJoint`'s own
   `EGMReset` and throwing "You have to disconnect an EGM instance using EGMReset before you
   can connect another." Recovery: `stop` → `resetpp` → `start`. No longer relevant for normal
   `gofa-egm` start/stop (which doesn't stop the task at all now) — only for genuinely external
   interruptions.
4. **If that same error persists even after a genuinely fresh `resetpp`+`start`**, the problem
   has moved to a stuck EGM resource at the **controller level** (the `EGM_PC` UC transport
   left "still connected" from a session killed mid-negotiation) — confirmed no RWS-visible fix
   exists; a full controller restart is the only recovery.

**Also found**: `EGM_PC`'s UDPUC Remote Address (the dev PC's IP) drifts the same way the
robot's own IP does — see [[project_robot_current_ip]]. Symptom when stale: `start` succeeds
(`OK:EGMJOINT`, UDP binds) but zero frames ever arrive, and nothing times out to reveal why —
check `EGM_PC`'s configured Remote Address against the current dev-PC IP first.

**Confirmed live, real motion, via the actual shipped node code**: `gofa-egm` `start` →
baseline hold (zero motion) → `+3°` target on joint 6 → telemetry shows a smooth ramp from
baseline to the full commanded offset → target back to baseline → smooth return → `stop` → TCP
mode restored, repeatably. Codec verified byte-for-byte against `gofa-egm-python`'s `egm_pb2`
reference output, not just self-consistency.

**Original design decisions (2026-07-08, still valid):**
1. **Auto-switch inside the EGM node** — one node (`gofa-egm`), sends `EGMJOINT` itself on
   `start`. No separate switch node.
2. **Hand-rolled protobuf codec** — no protobufjs dependency; `ws` stays the package's only
   runtime dep.
3. **Joint mode only for v1** — pose guidance + stream-only telemetry are still phase 2, not
   built; speed guidance + path correction still deferred; external axes still skipped
   permanently (no hardware).
4. **RAPID delivery as a sibling file**, not a merge into `MainModule.mod` — held up
   completely; `MainModule.mod` is confirmed byte-for-byte untouched throughout.

**Why:** [[user_learning_context]] — EGM is the only sub-10ms closed-loop channel on this
hardware; RWS tops out ~500ms. No business case yet, learning-driven.

**How to apply:** phase 2 (pose guidance, stream-only telemetry) isn't built — if the user asks
for it, extend `gofa-egm.js`'s codec (fields already mapped in the plan) and add the
corresponding RAPID commands to `MainModuleEGM.mod`. Reuse the TRAP/`EGMStop` graceful-exit
pattern for any new blocking EGM mode (e.g. `EGMRunPose` for pose guidance) rather than an
external kill — it's the confirmed-working design now, not the workaround. Remember the
unload-before-loadmod requirement if any new module variant is added. `ABB_Scalable_IO_0_DO16`
is reserved as the EGM graceful-stop trigger signal — don't reuse it for something else without
updating both `MainModuleEGM.mod` and `gofa-egm.js`.

**Open caution, not yet acted on (found 2026-07-09 cross-checking `C:\Users\anapa\nnnn\note\`'s
EGM manual):** ABB's manual requires correct tool load data (`LoadIdentify`) before EGM use —
wrong load data can cause servo torque overruns/safety halts under EGM's fast corrections.
`MainModuleEGM.mod`'s `tGripper` has an unverified placeholder mass (1kg), never run through
`LoadIdentify`. Not hit live yet (testing so far has been small-amplitude, no tooling
attached). Documented as a caution in `CLAUDE.md`, both READMEs, and `gofa-egm.html` — actually
running `LoadIdentify` is still outstanding if real tooling gets attached.

**Also 2026-07-09**: `C:\Users\anapa\nnnn\note\Node_RED_ABB_GoFa_Project_Analysis.md` (an
external reference note, not part of this repo) was found stale — described the old
external-RWS-stop design and the instance-leak as still-open. Fixed to match the TRAP/`EGMStop`
design and the resolved-instance-leak status. If more external notes reference this project,
they're not auto-synced and can drift the same way.

**Node split (2026-07-09, later session): `gofa-egm` split into `gofa-egm` (session control +
telemetry, Action dropdown start/stop) and a new `gofa-egm-move` node (movement only).** User
wanted `gofa-egm` to work like the palette's other action-style nodes (`gofa-motor`/
`gofa-rapid-exec`: config-time Action dropdown + bare-inject convention) and wanted movement
split into its own node that falls back to a second output (e.g. into `gofa-movej`) when EGM
isn't active, instead of erroring and dropping the message. Session state
(`_egmActive`/`_egmTarget`/`_egmBaseline`) moved from the `gofa-egm` node instance onto the
shared `gofa-robot` config node — same cross-node pattern already used by `_seqStop`/
`_seqRunning` (`gofa-stop-seq`/`gofa-sequencer`), found by having an Explore agent grep the
existing codebase for precedent before designing anything new. `gofa-egm-move` normalizes its
output to a bare `[j1..j6]` array on both outputs specifically because `gofa-movej.js` accepts
that shape directly (checked its source) — the fallback wiring needs zero `change` node.
Breaking change to `gofa-egm`'s old payload contract (joint arrays no longer accepted there) —
intentional, matches this project's no-back-compat-shim convention.

**Confirmed live** (same session): drove the real node files against the robot via a throwaway
script (fake-RED harness, real network I/O) — full start → `gofa-egm-move` target → real motion
(telemetry convergence) → back to baseline → stop → PING-confirmed TCP resume cycle worked;
fallback path confirmed genuinely end-to-end by feeding `gofa-egm-move`'s output 2 into a real
`gofa-movej` node and getting real `MOVEJ` motion. 140/140 unit tests pass. One minor
pre-existing (not a regression) observation: `robot._egmTarget` can be left non-null after
`stop()` due to a straggler UDP frame during the ~1s graceful-stop window re-triggering the
baseline-capture path — no functional impact (fallback check only reads `_egmActive`), same
hazard existed byte-for-byte before the split, not chased further. Full details in CLAUDE.md's
EGM section ("Node split" paragraphs).

**Real bug found post-publish (2026-07-09, follow-up session, published as npm 1.2.0): user hit
`bind EADDRINUSE 0.0.0.0:6510` on a second "Start EGM".** Root cause: the split above shared
`_egmActive`/`_egmTarget`/`_egmBaseline` via `robot`, but left the actual `dgram` socket as
node-instance-local state. With two separate `gofa-egm` instances (Start/Stop, the documented
pattern), Stop's `stopAll()` closed its own never-bound socket, not Start's real one — leaked
the UDP port until that instance redeployed. Diagnosed live: `netstat` showed the port held by a
stray process (turned out to be my own earlier leftover test script, confirmed via
`Get-CimInstance Win32_Process` command-line lookup before killing it — asked the user first
since process termination is a real-world side effect). **Fix**: moved the socket onto
`robot._egmSocket` too, same pattern as the rest. Also fixed a related gap the same incident
surfaced: if `EGMJOINT` acks (controller enters EGM mode) but the local UDP bind then fails for
any reason, the controller session used to be orphaned with no recovery — `start()` now
best-effort sends the graceful-stop signal in that case. Confirmed live: reproduced the exact
reported Start-A/Stop-B/Start-A sequence via the real node files, no `EADDRINUSE`, port cleanly
released each cycle. 142/142 tests pass (2 new). Published as npm 1.2.1 (patch — bug fix only).

**Lesson**: when sharing state across node instances via the config node (the `_seqStop`-style
pattern), audit *every* piece of session state that needs to move, not just the obviously
"data" fields — a live resource handle (socket, file handle, subscription) is state too, and
missing it produces exactly this kind of "works for the happy path, leaks on the realistic
multi-instance usage" bug that unit tests with a single mocked node instance won't catch (all
this session's original unit tests used one node instance per test, never two instances sharing
one robot — that blind spot is why this shipped in 1.2.0 and needed a live report to surface).

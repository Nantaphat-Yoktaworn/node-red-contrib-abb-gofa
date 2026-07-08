---
name: project_autonomous_sequence_feature
description: "Standalone RAPID sequence-runner feature (AutoSequence.mod) — goal, key decisions, plan location, progress"
metadata: 
  node_type: memory
  type: project
  originSessionId: c64b8762-5090-4585-80b6-af2e100c4b7b
---

User wants the robot to run a saved-point sequence **fully standalone** (no Node-RED at
runtime), controlled by a native FlexPendant UI, with the point list and per-step delay editable
without a regeneration round-trip through Node-RED for day-to-day edits.

Full plan is at `.claude/plans/autonomous-sequence-plan.md` in the repo (this is a project whose
Claude Code memory/plans are also snapshotted into the repo itself under `.claude/memory/` and
`.claude/plans/` for cross-machine continuity — see that directory's README and CLAUDE.md's
"Repo layout" section). Read the plan file for full design detail.

Key decisions locked in:
- Fully takes over the task (mutually exclusive with the Node-RED socket server — only one task
  can drive `ROB_1`).
- Deployed as a **separate module file** `AutoSequence.mod` (not a same-name replace of
  `MainModule.mod`), swapped via `unloadmod`/`loadmod`/`activate`/`resetpp`/`start`.
- Point list lives in a flat RAPID-native data file, not baked as RAPID `CONST`s — required so
  edits don't need recompiling anything.

**v3 (superseded)**: physical-I/O (ASI buttons + DSQC1030 DI) + on-screen FlexPendant menu +
single-file sequence. Confirmed live end-to-end but every hard bug traced back to the
interrupt-driven physical-I/O model (`ExitCycle`/`ERR_ALRDYCNT`, `StopMove`/`ClearPath` hangs on
an interrupted blocking move). Also confirmed: **switching opmode Auto→Manual stops RAPID and
cuts motors outright** — not something the module does, relevant to any live test toggling
opmode.

**v4 (current, branch `autonomous-sequence`)**: dropped all physical I/O — the on-screen menu is
the only control surface. No interrupts anywhere; Stop/Pause are checked only during the
post-move dwell (robot always stationary then) via a short-poll `TPReadFK \MaxTime:=0.5`, so
nothing is ever in flight to abort. Split "points" (a named, reusable library) from "sequence"
(an ordered list referencing library points by name). `rapid/AutoSequence.mod` v4 compiled clean
on the first real `loadmod` attempt.

**"Add Point can't be self-contained on-pendant" — resolved.** Root cause: jogging requires
Manual mode, and switching to Manual stops RAPID outright, so a menu `PROC` can never be running
while the operator jogs to a new position. Resolution: dropped "Add" from `PointsMenu` entirely,
replaced with **Import** — lists every `*.json` file in `$HOME/Programs/` (`OpenDir`/`ReadDir`/
`CloseDir`) via a `UIListView`, and parses whichever one is picked using the exact on-robot
point-storage shape `gofa-robot.js`'s `remoteSavePoints()` already writes
(`[{id,name,target:{x,y,z,q1..cfx}}]`, `JSON.stringify(...,null,2)`, one key per line — a
line-oriented scan, not a general JSON parser). Points still get taught the normal way (any
existing flow using `gofa-save-point` with `storage: remote`) — Import just needs the result to
land as a `.json` file under `$HOME/Programs/`, no dedicated seed/convert step. Import replaces
the whole in-memory library (not a merge) and re-saves it into the module's own cache file so it
survives a restart. Works in either opmode (pure disk I/O, no jogging involved). This made
`gofa-gen-sequence-data` (Node-RED's only remaining v3-era job) fully dead — deleted the node and
the "Seed Sequence Data" group from `flows/autonomous_sequence_flow.json`.

The `ImportFromJson` line-scan algorithm was verified in isolation (ported to plain JS, run
against real `JSON.stringify(points,null,2)` output — negative numbers, decimal vs integer
values, a name containing a space — all passed).

**Deploy confirmed live (2026-07-08)**, via a standalone deploy script (no Node-RED running —
called the same `gofa-robot.js` helpers the real nodes use directly): `loadmod` → `activate` →
`resetpp` → `start` all succeeded, full program consistency check passed at `resetpp`, RAPID
reached `running`. Two real compile errors surfaced and were fixed through this exact loop
(deploy → user reads the pendant's compile-error popup → fix → redeploy — RAPID compile errors
during `resetpp`'s consistency check do **not** appear in `/rw/elog`, confirmed by checking and
finding nothing there both times; only the pendant screen shows them, so a human at the pendant
is required to read them):
- `PROC AddLibEntry(string nm, num v{11})` — RAPID array **parameters** must be declared `{*}`
  (any-size), never a literal dimension (local `VAR` declarations can use a literal size — only
  parameters can't). Fixed to `num v{*}`.
- `ReadDir(d)` — guessed signature was wrong. Confirmed via ABB's RAPID Instructions, Functions
  and Data Types reference (`3HAC050917-001`, fetched via WebFetch/WebSearch and grepped with
  `pdftotext` since the PDF was too large/binary for WebFetch's own summarizer):
  `FUNC bool ReadDir(dir Dev, INOUT string FileName)` — returns whether a name was retrieved, the
  filename comes back through an INOUT parameter, not the return value. Fixed to
  `more := ReadDir(d, fname)`.

`OpenDir`'s path argument (`"$HOME/Programs/"`, not `"HOME:/Programs/"`) worked as originally
written — no fix needed. The doubled-quote string-literal escaping (`""""` for one embedded `"`)
was also independently confirmed against ABB docs and needed no fix.

**Import confirmed live end-to-end (2026-07-08)**: on the physical pendant, `Points → Import`
listed `gofa_points.json` and importing it reported both seeded points (`TestPoint1`,
`TestPoint2`) loaded successfully — no further RAPID fixes needed for `OpenDir`/`ReadDir`/
`CloseDir` or the JSON line-parser. This confirms the whole "Add Point can't be self-contained
on-pendant" redesign (see above) works as built, not just as planned.

**Third live bug found and fixed (2026-07-08)**: with a 2-point sequence running, Stop did not
reliably register — user had to cut motor power to halt it. Root cause: `DwellWithPoll` re-invoked
`TPReadFK` every 0.5s in a loop (and `PauseLoop` every 1s), which is a documented ABB anti-pattern
— the RAPID Instructions reference (`3HAC050917-001`) explicitly warns "Avoid using too low values
for the timeout parameter `\MaxTime` when TPReadFK is frequently executed, for example in a loop.
It can result in unpredictable behavior of the system performance, like slowing the FlexPendant
response." Fixed both to a single blocking `TPReadFK` call instead of a poll loop:
`DwellWithPoll` now calls it once with `\MaxTime:=<the actual remaining dwell>` (one call whether
the dwell is 200ms or 60s, not N calls of 0.5s each); `PauseLoop` now calls it once with no
`\MaxTime` at all (blocks indefinitely until Resume/Stop, same pattern `MainMenu` already used).
Redeployed clean, no new compile errors. `POINTS_FILE`/`SEQ_FILE` persist independently of module
reloads, so the library/sequence built in the previous test survived this redeploy. **Not yet
confirmed**: that Stop is now actually reliable during a running loop — next step is having the
user re-run the same 2-point sequence and try Stop/Pause again.

**Loop toggle added (2026-07-08)**, per user request after confirming Stop now works: the
sequence always wrapped back to step 1 forever with no way to run once. Added `PERS bool
bLoopSeq := TRUE` and a 4th `MainMenu` button (`Loop:On`/`Loop:Off`, toggles on press, redraws
the same menu) — `RunSequenceLoop`'s step-advance now checks it: wraps to step 1 when TRUE
(previous/default behavior), goes to `SEQ_IDLE` after the last step when FALSE. Redeployed clean.
Simple on/off only, not `gofa-sequencer`'s loop-count/ping-pong — deliberately scoped to what was
asked; add more later if actually needed. **Not yet confirmed live** — next step is toggling
`Loop:Off` and confirming the sequence runs once and returns to idle on its own.

Also explained to the user (not a bug, inherent to the no-interrupts v4 design): the Pause/Stop
buttons visibly flicker on/off once per step during a fast loop with a short dwell, because they
can only be shown while the robot is stationary (during the dwell) — they necessarily disappear
during each move. No fix planned; a longer per-step dwell makes it feel steadier.

**Still not yet done**: List, Edit Delay, Remove Step, Delete a library point,
fault-on-missing-point. Needs a human at the physical pendant, no RWS equivalent for
`TPReadFK`/`UIListView` input.

Robot IP has been observed drifting within the same day in past sessions (documented default
`.33` → `.36` → `.15` seen on 2026-07-07) — always re-check with `/robot-status` rather than
trusting a recorded IP.

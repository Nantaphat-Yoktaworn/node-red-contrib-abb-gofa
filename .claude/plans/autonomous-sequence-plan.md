# Plan: Standalone autonomous point sequencer (RAPID-native, FlexPendant-editable)

## Context

The user wants the robot to run a saved-point sequence **fully standalone** (no Node-RED at
runtime) — started/stopped/paused by physical I/O and the FlexPendant itself, with the point
list and per-step delay editable directly on the FlexPendant (no regeneration round-trip through
Node-RED needed for day-to-day edits).

This plan went through two revisions before landing here:
1. First pass: RAPID-native `TPReadFK`/`UIMsgBox`/`UINumEntry` menu for the FlexPendant UI.
2. Second pass: pivoted to a persistent OmniCore App SDK web-app dashboard after the user said
   they wanted something more like the FlexPendant's own jogging/production screens, not
   sequential popups. **Investigated and ruled out** — see
   [[reference_omnicore_appstudio_investigation]] memory for the full trail. Short version:
   AppStudio itself is free and license-clean, but actually getting a custom app to appear on the
   FlexPendant requires **RobotStudio + the AppStudio add-in** — a GUI install/registration step
   on the user's PC, confirmed empirically (a raw `fileservice`-deployed `appinfo.xml`+`index.html`
   produced nothing on the FlexPendant's Operate → Dashboard screen) and corroborated by ABB forum
   references to an "Add-ins list" registration step. That breaks this project's whole pattern of
   everything being scriptable via RWS/RAPID with no GUI-tool dependency, so it's out of scope.
3. **This final version**: back to the RAPID-native menu from pass 1, which is already confirmed
   live and working, no extra tooling, fully within how the rest of this project operates.

Decisions locked in during planning:
- **Fully takes over the task** — not meant to coexist with the Node-RED socket server. Only one
  task can drive `ROB_1` (confirmed: Multitasking `3114-1` *is* licensed here, but that only buys
  extra background logic tasks, not a second motion controller for the same arm), so "autonomous
  mode" and "Node-RED socket mode" are mutually exclusive, swapped in deliberately.
- **Deployed as a separate module file** (`AutoSequence.mod`), not a same-name replacement of
  `MainModule.mod` — confirmed feasible: `unloadmod` works live (see Progress) and multiple
  `ProgMod`s can coexist loaded so long as only one defines `main()`.
- **Control is a mix**: physical I/O (ASI buttons + DSQC1030 DI) *and* on-screen FlexPendant
  function-key buttons, all live at once.
- **Start behavior**: physical-button Start is deterministic (no one's watching a screen to
  answer a prompt); on-screen Start can interactively ask "Restart from step 1 or Resume?" via
  `UIMsgBox` since a human is present to answer.
- Pause responsiveness (graceful-between-points vs. immediate-mid-move) was never directly
  answered by the user — this plan defaults to **graceful, checked-between-points** (simpler, no
  path-resume logic) since that was the recommended option and nothing contradicted it. Stop
  stays **immediate** (`StopMove`/`ClearPath`/`StartMove`), matching the existing socket `STOP`
  command's behavior. Flagged in Open Risks in case this default is wrong.
- All implementation happens on git branch `autonomous-sequence` (already created), not `main`.

## Architecture

Two pieces:

1. **`rapid/AutoSequence.mod`** (new, hand-authored, checked into the repo like `MainModule.mod`)
   — the standalone program. Owns its own `main()`, its own persisted point+delay list (a flat
   file on the controller's disk, loaded/saved directly by RAPID — the same idiom `LoadHome`/
   `SaveHome` already use for `HOME_FILE`), interrupt-driven physical I/O control, and a native
   FlexPendant menu built from RAPID's built-in TP/UI instructions (`TPReadFK`, `UIMsgBox`,
   `UINumEntry`) — confirmed live on this controller (RobotWare 7.21.0+229), no FlexPendant SDK,
   no extra license, no compiled/installed app.
2. **A small Node-RED "seed data" generator** — the point list has to live in a plain,
   pendant-editable data file (not baked as RAPID `CONST`s — those can't be appended to at
   runtime), so Node-RED's job is just producing that file's *initial* contents from existing
   saved points, reusing `gofa-sequencer`'s exact steps-list UI and point-lookup code. Everything
   else about deployment reuses existing nodes (`gofa-upload-mod`, `gofa-rapid-exec`).

## `rapid/AutoSequence.mod` design

**Data file** (`CONST string SEQ_FILE := "$HOME/Programs/gofa_autoseq_data.cfg"`, same
`Open`/`Write`/`ReadStr`/`Close` idiom as `HOME_FILE`): one line per step —
`x;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx;dwellMs;moveType` (moveType: `0`=MoveJ, `1`=MoveL). Parsed
with an extended version of the existing `ParseNums` pattern.

**In-memory storage**: fixed-size `PERS` arrays sized to a reasonable cap (e.g. 50 steps, same
spirit as the 16-signal cap on `SETDO`) — `pSeq{50}` (robtarget), `nSeqDwell{50}`,
`nSeqMoveType{50}`, `nSeqCount`. `LoadSequence`/`SaveSequence` procs round-trip these against
`SEQ_FILE`, mirroring `LoadHome`/`SaveHome`.

**State machine**: `seqState` = `IDLE` / `RUNNING` / `PAUSED` / `FAULT`. Main loop branches on
`OpMode()`:
- **Auto**: status view + run controls. `TPReadFK` shows a looping menu (status line +
  Start/Stop/Pause as function-key buttons, redrawn after every action — a persistent-feeling
  control loop, not a one-shot popup chain) as on-screen buttons; physical-signal `TRAP`s
  (`CONNECT`/`ISignalDI`) fire concurrently — RAPID interrupts preempt any blocking instruction
  (a `TPReadFK` wait, a `WaitTime`, a motion instruction), which is fundamental, long-standing
  RAPID interrupt behavior, not something specific to this controller that needs a live spike.
  - Physical Start trap: `PAUSED → RUNNING` (resume) or `IDLE → RUNNING` (restart from step 1) —
    deterministic, no prompt.
  - On-screen Start: if there's a paused/stopped mid-sequence state, `UIMsgBox` asks
    "Restart / Resume" (`\Result` is type `btnres`, **not** `bool` — confirmed live via a real
    compiler error) before proceeding.
  - Stop (physical or on-screen): immediate `StopMove; ClearPath; StartMove`, `seqState := IDLE`.
  - Pause (physical or on-screen): sets a flag checked once per step boundary (`WaitIfPaused`
    called between each move) — not mid-move.
- **Manual**: edit menu instead of run controls (editing requires physical presence anyway,
  consistent with normal ABB jog-authority safety model). `TPReadFK`: Add / Remove / Edit Delay.
  - Add: capture `CRobT()` at the current (jogged) pose, `UINumEntry` for dwell
    (`\Header`/`\MsgArray`/`\InitValue`/`\MinValue`/`\MaxValue`, confirmed live syntax), a
    `UIMsgBox` for MoveJ/MoveL, append, `SaveSequence`.
  - Remove / Edit Delay: a simple numbered list via `TPReadFK`/`TPWrite` to pick an existing
    step (`UIListView`'s exact syntax wasn't needed/tested this round — `TPReadFK`-driven
    numbered selection is proven and sufficient), then remove or `UINumEntry` a new dwell,
    `SaveSequence`.

**Status LED**: reuse the existing `SetGO Asi1Led{Red,Green,Blue,Period}` pattern from
`MainModule.mod` (idle/running/paused/fault colors) — no new mechanism.

**Fault handling**: an `ERROR` handler around the run loop mirrors `MainModule.mod`'s
`ServeClient` philosophy (never let one motion fault kill the task) — sets `FAULT`, LED red,
clears the path, and waits for an operator Start (physical or on-screen) to clear it. This
matters more here than in `MainModule.mod` since there's no Node-RED to notice and intervene.

## Node-RED side changes

1. **New node `gofa-gen-sequence-data`** (`nodes/gofa-gen-sequence-data.js` + `.html`):
   - Config: `robot`, `storage` (local/on-robot — same as `gofa-sequencer`), `steps` (identical
     editable-list UI to `gofa-sequencer.html`'s point/dwell/moveType rows, copy the pattern),
     default dwell/moveType, remote data-file path (default matches `AutoSequence.mod`'s
     `SEQ_FILE` constant).
   - On input: resolves `steps` against `getPoints()`/`remoteGetPoints()` exactly like
     `gofa-sequencer.js` does (reuse that lookup code, not reinvent it), formats the flat
     `SEQ_FILE` lines, outputs `{ content: <string>, remotePath: <path> }`.
2. **Small enhancement to `gofa-upload-mod.js`**: currently it only accepts file content via a
   `Buffer` payload or a `localPath` (disk read) — there's no path for "here's the text content
   directly, no disk file involved." Add: if `msg.payload.content` is a string/Buffer, use it
   directly as the upload body (skip the disk read). This lets `gofa-gen-sequence-data`'s output
   feed straight into the existing upload node with no new upload logic.
3. **New `unloadmod` action on `gofa-rapid-exec.js`**: mirrors the existing `loadmod` action
   exactly — path-based, `rwsPostHal`, edit-mastership-gated (`POST /rw/rapid/tasks/{task}/
   unloadmod`, body `module=<name>`) — **confirmed live** (see Progress), safe to build as-is.
4. **New example flow tab** `flows/autonomous_sequence_flow.json`:
   - `gofa-gen-sequence-data` → `gofa-upload-mod` (seed the data file).
   - "Deploy Autonomous Mode" button chain: stop → unloadmod `MainModule` → upload
     `AutoSequence.mod` → loadmod `AutoSequence` → activate `AutoSequence` → resetpp → start.
   - "Restore Node-RED Control" button chain: stop → unloadmod `AutoSequence` → loadmod
     `MainModule.mod` (replace=true) → activate `MainModule` → resetpp → start.
   - Per the documented `gofa-rapid-exec` chaining hazard (its own `{ok:true, action}` output
     shape gets misread as an override by the next chained instance), insert a `change` node
     resetting `msg.payload` to `{}` between every pair of chained `gofa-rapid-exec` nodes in
     both chains.

## Progress (confirmed live this session)

1. ✅ `unloadmod`: `POST /rw/rapid/tasks/{task}/unloadmod`, body `module=<name>`, same
   hal+json/edit-mastership shape as `loadmod`/`activate`. Verified end to end: uploaded a
   harmless spare module (`SpareTestMod.mod`, no `main()`), `loadmod`'d it alongside the
   already-loaded `MainModule` (both listed as `ProgMod` — confirming multiple `ProgMod`s *can*
   coexist loaded in one task), `unloadmod`'d it, confirmed gone via the modules list,
   `MainModule` untouched throughout. Documented in `CLAUDE.md`'s new "`unloadmod` note".
2. ✅ `TPReadFK`/`UIMsgBox`/`UINumEntry`: compiled and ran clean on the second try (first attempt
   had `UIMsgBox`'s `\Result` typed `bool` instead of the correct `btnres` — a real compiler
   error, now baked into the design above). All three dialogs displayed and worked correctly on
   the physical FlexPendant (RobotWare 7.21.0+229 / OmniCore C30).
3. ❌ OmniCore App SDK / AppStudio dashboard — investigated and ruled out, see
   [[reference_omnicore_appstudio_investigation]].

## Remaining work

- Write `rapid/AutoSequence.mod` per the design above.
- Build `gofa-gen-sequence-data` node.
- Enhance `gofa-upload-mod` for direct content payload.
- Add `unloadmod` action to `gofa-rapid-exec`.
- Build `flows/autonomous_sequence_flow.json`.
- End-to-end live test: seed data from real saved points → deploy → physically exercise
  Start/Stop/Pause via ASI button, DSQC1030 DI, and on-screen function keys → confirm LED/status
  matches → add/remove a point via the Manual-mode menu → restart the controller task and
  confirm the edited list persisted (reloaded from `SEQ_FILE`) → restore Node-RED control and
  confirm the socket server works again.

## Open risks

- Pause granularity (graceful-between-points vs. immediate-mid-move) was never directly
  confirmed by the user — proceeding with graceful-between-points as the lower-risk default. If
  mid-move interruption turns out to matter, that needs `StorePath`/`RestoPath` and is a
  meaningfully bigger change to the run-loop design — worth confirming before the end-to-end test
  rather than after.
- `UIListView`'s exact syntax was never tested live (the Remove/Edit-Delay menu design above uses
  a simpler `TPReadFK`-driven numbered-list selection instead, which sidesteps needing it).

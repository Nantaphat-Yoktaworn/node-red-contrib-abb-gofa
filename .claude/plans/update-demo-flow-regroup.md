# Update & regroup `flows/gofa_demo_flow.json`

## Context

`flows/gofa_demo_flow.json` is the "one inject per node" demo flow for the palette. It currently has 15 numbered groups organized purely by *function* (Read State, Move Home, Motor Control, Jog, Saved Points, TCP Motion, I/O, Subscriptions, etc.), mixing RWS-protocol and TCP-socket-protocol nodes within the same group.

Two things prompted this update:
1. The palette now registers **41 node types** (`node-red-contrib-abb-gofa/package.json`), but the demo flow is missing one: **`gofa-asi-led`** (ASI status light, added in a recent commit) has no demo entry at all.
2. The user wants the flow reorganized so the **top-level grouping is by communication protocol** (RWS HTTPS vs TCP Socket), and *within* each protocol group, nodes are grouped again by function — i.e. real Node-RED **nested groups** (group-in-group), not just a naming convention.

Verified against the installed Node-RED (v5.0.1, `@node-red/editor-client/public/red/red.js`, `addToGroup`/`ungroup`/`createGroup`) that nested groups are a first-class feature: a child group is just another member — it gets `g: <parentGroupId>` and its id is listed in the parent's `nodes` array, exactly like a leaf node. Bounding boxes (`x/y/w/h`) are cosmetic only (Node-RED recomputes them on drag) and can be derived from the min/max of member coordinates plus a margin.

Decisions confirmed with the user (AskUserQuestion):
- Add gofa-asi-led demo entries (a "Set Yellow Blink" and a "Reset LED" chain).
- Nodes with **no network protocol at all** (`gofa-point-list`, `gofa-delete-point`, `gofa-points-export`, `gofa-points-import` — pure `points.json` disk I/O) get their own **third top-level group, "Local (No Network)"**, rather than being folded into RWS/TCP.
- `gofa-leadthrough-enable` (sends a TCP `STOP` first, then an RWS call to actually activate hand-guiding) goes under **RWS**, paired with `gofa-leadthrough-disable`.
- Fix the stale `gofa-upload-mod` `localPath` (`C:\Users\anapa\nnnn\ABB-GoFa-12\...`) to this repo's actual path.

Only `flows/gofa_demo_flow.json` is in scope — not `dashboard_flow.json`.

## Target structure

Three top-level groups (protocol), each containing nested function subgroups. Existing node ids, wiring, and node property values are preserved as-is — only `g` (group membership) and `x`/`y` (position, rigidly translated per subgroup, no internal relayout) change, plus the additions/fix below.

**1. RWS (HTTPS 443)** — stroke `#0099cc`
- Read Robot State — status, pose, joints
- Motor Control — motor on/off
- Save Point — `gofa-save-point` (reads pose via RWS, writes locally)
- System, Log & Files — system-info, elog, file-read, upload-mod *(fix `localPath` here)*
- I/O Signals — io-list, di-read, ai-read, do-write, ao-write
- Lead-through — leadthrough-enable, leadthrough-disable
- Real-time Subscriptions — subscribe-state, subscribe-io, subscribe-var, subscribe-pose
- RAPID Execution Control — rapid-exec (resetpp/start/stop)

**2. TCP Socket (port 1025)** — stroke `#00aa44`
- Move Home / Set Home — gofa-move
- Cartesian Jog — gofa-jog
- Joint Jog — gofa-joint-jog
- TCP Motion — ping, movej, grip on/off, zone-set, stop-motion
- Speed & RAPID Variables — speed-set, rapid-var-read ×2, rapid-var-write ×2 *(new comment node — none existed before)*
- Go To Point — `gofa-go-point` *(new comment node)*
- Sequence Runner — sequencer, stop-seq
- **ASI Status LED — NEW**: comment + "Set Yellow Blink" chain (`{"color":"yellow","blinkCount":3,"blinkMs":250}`) + "Reset LED" chain (`"reset"`), each inject → `gofa-asi-led` → debug

**3. Local (No Network)** — stroke `#009999`
- Point List & Delete — point-list, delete-point *(new comment node)*
- Points Transfer — points-export, points-import

The existing "Saved Points" comment (`f86919c88aa4e591`, currently "Run in order: 1-Save 2-List 3-Go To 4-Delete") is reused/reworded in the new **Save Point** subgroup to explain the workflow now spans three protocol groups (Save→RWS, Go To→TCP, List/Delete→Local).

## Implementation approach

Do this with a one-off Node.js script (`scratchpad/restructure_demo_flow.js`), not manual JSON editing — the flow has ~140 nodes and hand-editing risks silently breaking `g`/`nodes` bidirectional references.

Script steps:
1. Load `flows/gofa_demo_flow.json`, index nodes by id.
2. Declare the target tree (as above) as data: for each top-level group, a list of subgroups, each with an ordered list of *existing* node ids (comment/inject/gofa-node/debug, pulled straight from today's file) plus placeholders for the handful of brand-new nodes.
3. Create the new node objects (4 comment nodes, 2 injects, 2 `gofa-asi-led` nodes, 2 debugs) with generated ids in Node-RED's 16-hex-char style, following the exact field shape used by neighboring nodes in the file (same `props`/`repeat`/`crontab`/`once`/`onceDelay` for injects; same debug field set).
4. Remove the 15 old top-level `group` objects.
5. For each subgroup: compute its current bounding box from its member nodes' existing `x`/`y`, translate every member node by a delta so the subgroup lands in its column (RWS / TCP / Local, left-to-right) at its stacked vertical slot (subgroups stacked top-to-bottom within a column, ~40px gap) — internal relative layout within a subgroup is untouched, only rigid translation. New nodes get coordinates following the same visual pattern as other subgroups (comment top row, then inject → node → debug columns, ~55px row pitch).
6. Set each member's `g` to its subgroup id; set each subgroup's `g` to its top-level group id; build every group's `nodes` array from its direct members; compute each group's `x/y/w/h` as the bounding box of its members + ~25px margin (mirrors Node-RED's own `addToGroup` math).
7. Patch `gofa-upload-mod`'s `localPath` to `C:\Users\RD2\nnnn\node-red-contrib-abb-gofa\rapid\MainModule.mod`.
8. Write the file back with the same 4-space-indent JSON formatting as the original.
9. Leave `cfg1` (gofa-robot config) and the `global-config` node untouched at the end of the array — config nodes aren't group members.

## Files touched

- `flows/gofa_demo_flow.json` (rewritten by the script)
- `scratchpad/restructure_demo_flow.js` (throwaway script, not committed — lives in the session scratchpad dir, not the repo)

## Verification

1. `node -e "JSON.parse(require('fs').readFileSync('flows/gofa_demo_flow.json'))"` — valid JSON.
2. A consistency check (inline Node script) asserting:
   - Every non-tab/non-config node's `g` resolves to an existing group.
   - Every group's `nodes` array is exactly the set of nodes whose `g` equals that group's id (bidirectional match, no orphans/duplicates).
   - Exactly 3 groups have no `g` (the top-level ones).
   - All 41 `node-red` entries from `node-red-contrib-abb-gofa/package.json` (including `gofa-robot`) appear at least once as a `"type"` in the flow — closes the completeness gap this task started from.
   - Wire targets still resolve (ids weren't touched, but confirm nothing was dropped).
3. Load the rewritten flow for real in Node-RED: run `node-red` (already installed globally, v5.0.1, palette already linked into `~/.node-red`) against a scratch `--userDir`/`--flowfile` pointed at the new JSON, confirm it starts with no "invalid flow"/group errors, then stop it. This is the strongest signal since it uses Node-RED's own flow loader rather than my own assumptions about the schema.
4. Re-run `npm test` in `node-red-contrib-abb-gofa/` (existing 70 unit tests) to confirm the unrelated `localPath` edit and node additions didn't touch anything the tests cover.

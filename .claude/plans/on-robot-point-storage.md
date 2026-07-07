# On-robot point storage (no local points.json needed)

## Context

Today, saved points (`gofa-save-point`, `gofa-go-point`, `gofa-delete-point`,
`gofa-point-list`, `gofa-sequencer`) live entirely in `points.json` on the
Node-RED host, managed synchronously in `gofa-robot.js` (`_loadPoints`/
`_savePoints`/`addPoint`/`deletePoint`/`findPoint`/`getPoints`, `nodes/gofa-robot.js:190-239`
per the current file). The user wants an option to store points **on the robot
controller itself**, so the point list works without any file on the remote PC.

The user's first framing was "save it into the `.mod`" (i.e. inside
`MainModule.mod`/RAPID). That's not viable: RAPID's `string` type has a hard
80-character cap — this codebase already rounds `GOTO` token coordinates
specifically to survive it (see the `gofa-robot.js` `gotoToken()` comment and
`CLAUDE.md`'s "Saved points format" section). A single point record
(`name;x;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx`) already brushes that limit for one
point with a short name; parsing a growing list of them through RAPID
`string`/`ReadStr` would be fragile and would need RAPID code changes reloaded
via `loadmod` — which we just confirmed requires RAPID to be **stopped**
(session finding, `CLAUDE.md`'s "Module reload (`loadmod`) note").

Presented this tradeoff to the user directly; they chose (via AskUserQuestion):
1. **Extend the existing 5 nodes** with a Storage toggle, not new dedicated nodes.
2. **Node-RED still drives the sequencer** (one socket command per point) —
   only where the point *data* lives changes, not who's in charge of timing.
3. **Storage mechanism: a JSON file on the robot's own disk, managed purely
   over RWS `GET`/`PUT` fileservice** (the exact mechanism `gofa-upload-mod`/
   `gofa-file-read` already use) — not new RAPID socket commands. This avoids
   the 80-char limit entirely (it's raw HTTP, no RAPID `string` involved) and
   needs **zero changes to `MainModule.mod`** — the on-robot points file is a
   plain sibling file next to it (like `gofa_home.cfg` already is), invisible
   to RAPID. Movement still goes through the existing `GOTOJ`/`GOTOL` socket
   protocol and `gotoToken()` — only the *lookup* of a point's coordinates
   moves from the in-memory `points.json` array to an RWS-fetched-and-parsed
   array.

## Design

### `gofa-robot.js` — new async remote-storage methods

Add a config field `remotePointsPath` (default `$HOME/Programs/gofa_points.json`,
mirroring `gofa-upload-mod`'s `remotePath` default pattern) alongside the
existing `pointsFile` (local path) field.

Add four methods mirroring the sync local ones, built on the existing
`requestRaw()` (for `GET`, so a `404` can be turned into `[]` instead of a
rejection — `rwsGet()` rejects on any non-2xx, which we don't want here) and
`rwsPut()` (already supports an explicit content-type param, added for
`gofa-upload-mod`):

- `remoteGetPoints()` → `GET /fileservice/<remotePointsPath>` via `requestRaw`;
  `404` → `[]`; otherwise `JSON.parse(body)`.
- `remoteSavePoints(points)` → `rwsPut(path, JSON.stringify(points, null, 2), <content-type TBD by curl test>)`.
- `remoteAddPoint(name, target)` → fetch, dedupe/auto-name exactly like
  `addPoint()` does today (same "Point N" logic, same duplicate-name error
  shape `{ error }`), push, save, resolve the new point.
- `remoteDeletePoint(idOrName)` → fetch, filter out the match, save, resolve
  the deleted point (or `null` if not found).
- `remoteFindPoint(nameOrId)` → fetch, `find()`, resolve point or `null`.

Add an admin endpoint for the editor's point-picker dropdowns (mirrors the
existing `RED.httpAdmin.get('/gofa-robot/:id/points', ...)` at
`nodes/gofa-robot.js:251`, which only serves the local sync array):
`GET /gofa-robot/:id/remote-points` → `node.remoteGetPoints().then(...).catch(() => [])`.

**Known, accepted limitation:** no concurrent-write protection on the remote
file (no ETag/mtime check, unlike local storage's mtime-drift warning) —
acceptable for a human-paced "teach a point" workflow; noting it in docs
rather than building it.

### The 5 nodes — add a Storage toggle

Each gets a `storage` config field (`'local'` default / `'remote'`), a
`msg.payload.storage` override (same override pattern already used everywhere
else in this palette, e.g. `gofa-rapid-exec`'s `action`), and branches between
the sync local call and the async remote call:

- **`gofa-save-point.js`** — branch `r.addPoint(...)` vs
  `r.remoteAddPoint(...).then(...)`, then reply with the full updated list
  (`r.getPoints()` vs `r.remoteGetPoints()`).
- **`gofa-go-point.js`** — branch `Promise.resolve(r.findPoint(...))` vs
  `r.remoteFindPoint(...)`; rest of the flow (`gotoToken` → `socketSend`)
  unchanged.
- **`gofa-delete-point.js`** — same shape as save-point, delete + relist.
- **`gofa-point-list.js`** — branch sync `r.getPoints()` vs
  `r.remoteGetPoints().then(...)`.
- **`gofa-sequencer.js`** — fetch the **whole** points array **once** up front
  (`Promise.resolve(r.getPoints())` vs `r.remoteGetPoints()`), then keep the
  existing synchronous step-resolution loop (`cmds` building, `pingpong`,
  `startStep` clamp) exactly as-is against that fetched array — avoids one RWS
  round-trip per step. `runStep()`'s dwell/loop/stop logic and `r.socketSend()`
  calls are entirely untouched.

Editor-side (`.html` for each): add a "Storage" dropdown next to the existing
fields; the point-picker dropdowns (`gofa-go-point.html`, `gofa-delete-point.html`,
`gofa-sequencer.html` — all currently call `$.getJSON('/gofa-robot/'+id+'/points', ...)`)
switch to `/gofa-robot/:id/remote-points` when Storage is set to On-Robot.
`gofa-robot.html` gets a new "Remote Points Path" field next to "Points File".

## Verification (per your instruction: curl first, then the node)

1. **Curl-test the RWS mechanism directly, before writing any node code:**
   `GET`/`PUT /fileservice/$HOME/Programs/gofa_points.json` — confirm `404`
   on a path that doesn't exist yet, confirm a round-trip `PUT` then `GET`
   returns the same JSON, and confirm which Content-Type actually works
   (`application/json` vs the `text/plain;v=2.0` `gofa-upload-mod` already
   uses) using `check-status.js` first to confirm the robot's reachable.
2. **Implement** `gofa-robot.js`'s remote methods + admin endpoint, then the 5
   nodes' storage branch + editor UI.
3. **Test the actual node code against the live robot** (the same
   fake-`RED`-harness technique used earlier this session) for: save (remote),
   list (remote), go-to (remote), delete (remote), sequencer (remote) — not
   just mocks.
4. Add mocked unit tests to `test.js` for the new remote-storage code paths,
   using a robot mock that only exposes the real public methods (per this
   project's `feedback-grep-all-nodes-after-shared-internals-refactor` lesson
   — don't invent private-field mocks).
5. Run the full suite (`node test.js`) and `check-status.js` before/after live
   testing to confirm no side effects.
6. Update `CLAUDE.md` (nodes table, "Saved points format" section),
   `README.md` (Saved points section, node tables), and `MANUAL_CONTROL.md`
   (new RWS read/write pair for the points file) to document the new storage
   mode and its one known limitation (no concurrent-write protection).
7. Log the RWS fileservice `404`/content-type findings in the
   `project_robot_live_test_log` memory, matching this session's established
   pattern.
8. **Do not commit/push** without an explicit request, consistent with every
   round this session.

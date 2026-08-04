# Changelog

Release history and upgrade notes for `node-red-contrib-abb-gofa`.

Node removals in this project are **replacements, not aliases** — a removed node type is gone,
not shimmed. A flow built with an older version shows "unknown node" for those types and has to
be edited. Each entry below says exactly what to replace them with.

---

## 2.6.1 — documentation only

No code or behavior change. The README shipped with 2.6.0 had drifted from the code: it claimed
43 nodes (there are 37 plus the config node), told you to `npm install` a `ws` dependency that no
longer exists, and led with 2.5.2's release notes.

Documentation is now split by task — [getting started](docs/getting-started.md) (including a
first-move tutorial), [node reference](docs/reference.md), and
[troubleshooting](docs/troubleshooting.md) — with release history collected here.

`MODULE_VERSION` in the RAPID modules is bumped in lockstep for provenance only. **A controller
still running the 2.6.0 module stays compatible and does not need re-flashing** — the version
handshake compares major.minor only.

---

## 2.6.0 — `gofa-joint-jog` merged into `gofa-jog`

**Breaking: `gofa-joint-jog` is removed.** Its single-joint jogging moved into `gofa-jog` as extra
entries on that node's existing axis dropdown, now labelled **Target**:

| Target | Frame / units | Step clamp |
|--------|---------------|-----------|
| `X` `Y` `Z` | base frame, mm | 1–50 |
| `RX` `RY` `RZ` | tool frame, degrees | 1–30 |
| `J1`–`J6` | single joint, degrees | 1–30 |

There's no Action dropdown to pick between Cartesian and joint mode — both old nodes took exactly
the same `(selector, direction, step)` parameters and differed only in which socket command they
emitted, so the Target selector carries the mode itself.

**To migrate a flow:** replace each `gofa-joint-jog` node with a `gofa-jog` node and set **Target**
to the joint you were jogging. Editing the flow JSON directly works too — change `"type"` to
`"gofa-jog"` and rename the `"joint"` field to `"target"`.

**What keeps working without any edit:**

- Existing `gofa-jog` nodes saved before 2.6.0 (stored `axis` config is migrated to `target` on
  first open).
- `msg.payload.axis` and `msg.payload.joint` are still read as aliases for `msg.payload.target`.
  Precedence is `target` → `axis` → `joint`.
- A bare number or numeric string (`3`, `"3"`) still works as joint shorthand.

**No RAPID change** — `MainModule.mod` already had separate handlers with their own clamps, so a
controller running the 2.5.x module does not need re-flashing.

Also fixed by the merge: `gofa-joint-jog` used to reject a lowercase `j1` while `gofa-jog` accepted
a lowercase `ry`. Both are accepted now. The jog algorithm existed in four near-copies (two runtime
handlers, two editor admin routes) and is now one shared `nodes/lib/jog.js`.

Live-verified 2026-08-04: 20/20 checks against the real controller, every move paired with its
exact inverse, arm returned to the start pose within 0.117° on the worst joint.

---

## 2.5.2 — bug-fix release

Fourteen fixes from a full source audit; five confirmed against the live controller. No RAPID
protocol change — `MODULE_VERSION` is bumped in lockstep for provenance only, so a module still
reporting **2.5.x remains compatible** and does not need re-flashing.

**Behavior change: `gofa-movej` no longer moves on a malformed target.**

It used to treat a *malformed* joint payload the same as *no* payload — both silently fell back to
the node's configured joints **and moved the arm there**. A 5-element array, or an object with no
joint keys, therefore moved the robot to a pose the flow never asked for. Those now return an error
and send no motion command.

Unchanged, so inject-triggered flows keep working: `undefined`/`null`, a number (an inject
timestamp), a boolean, an empty string, `{}`, and `{moveType:'L'}` all still fall back to the
configured joints.

**Other fixes:**

- `gofa-setup` now actually performs its `T_LED` reload — it was silently skipped on every
  deployed run.
- The editor Setup panel no longer warns about a compatible patch-level module version.
- Fileservice paths containing a space no longer fail.
- `gofa-asi-led` no longer double-calls `done()` when closed mid-blink.
- The `gofa-subscribe-*` nodes no longer leak one controller subscription per reconnect (the
  controller caps concurrent subscriptions at 19).
- `gofa-points` refuses to save an incomplete robtarget instead of persisting nulls.
- `gofa-connection-status` can no longer take down the Node-RED process via an unhandled rejection.
- `discover()` no longer opens an unbounded number of sockets.
- Published examples and the palette defaults are now guarded by a test so they can never ship
  with `allowInsecureLiveControl` enabled.

---

## 2.5.0 — five point nodes merged into `gofa-points`; local point storage removed

**Breaking: four node types are removed.** Replace each with a `gofa-points` node and pick the
matching **Action**:

| Old node (removed) | Replace with | Action |
|---|---|---|
| `gofa-save-point` | `gofa-points` | `save` |
| `gofa-go-point` | `gofa-points` | `go` |
| `gofa-point-list` | `gofa-points` | `list` |
| `gofa-delete-point` | `gofa-points` | `delete` |

`gofa-points`' own existing `export`/`import` actions are unchanged.

**Breaking: points are now stored only on the robot.** The **Storage** option (Local / On-Robot)
and the `msg.payload.storage` override are gone, along with the `gofa-robot` config node's
**Points File** field. Every point now lives in a single JSON file on the controller's own disk —
the config node's **Remote Points Path**, default `$HOME/Programs/gofa_points.json` — read and
written over RWS `fileservice`.

If you were using Local storage, your existing `points.json` on the Node-RED host is not migrated
automatically. Use `gofa-points` action `import` pointed at that file to load its contents onto the
robot — note that `import` **replaces** the robot's whole list.

**Payload note:** `gofa-points` deliberately does *not* follow the bare-string-is-the-action
convention used by `gofa-rapid-exec`/`gofa-motor`. Only `msg.payload.action` selects the action; a
bare string is the point name (`save`/`go`/`delete`) or the file path (`export`/`import`).

---

## 2.4.10 — editor live-control buttons require `adminAuth`

Every node's edit dialog has live-action buttons (jog, move, motors on/off) backed by Node-RED
admin HTTP endpoints. As of this release those motion endpoints are **refused with HTTP 403 when
`adminAuth` is not configured**, so an unauthenticated editor port can no longer be used to move
the robot.

For a deployment protected by network isolation instead of `adminAuth`, tick **Allow insecure live
control** on the `gofa-robot` config node to re-enable them, at your own risk.

Deployed flows use a separate runtime path and are never affected by this guard.

---

## 2.0.0 — six single-action nodes merged into three action-dropdown nodes

**Breaking: six node types are removed.** Replace each with its successor and pick the action:

| Old node (removed) | Replace with | Action |
|---|---|---|
| `gofa-leadthrough-enable` | `gofa-leadthrough` | `enable` |
| `gofa-leadthrough-disable` | `gofa-leadthrough` | `disable` |
| `gofa-points-export` | `gofa-points` | `export` |
| `gofa-points-import` | `gofa-points` | `import` |
| `gofa-file-read` | `gofa-file` | `download` |
| `gofa-upload-mod` | `gofa-file` | `upload` |

Behavior, payload overrides, and outputs are unchanged per action. `gofa-file` also gains a new
`delete` action. The bundled example flows are already migrated.

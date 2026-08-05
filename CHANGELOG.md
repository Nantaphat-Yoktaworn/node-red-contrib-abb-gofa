# Changelog

Release history and upgrade notes for `node-red-contrib-abb-gofa`.

Node removals in this project are **replacements, not aliases** — a removed node type is gone,
not shimmed. A flow built with an older version shows "unknown node" for those types and has to
be edited. Each entry below says exactly what to replace them with.

---

## 2.6.3 — fix: "Go to point" failed with `ERR:GOTOJ` on most taught points

**`gofa-points` (action `go`) and `gofa-sequencer` could send a goto request too long for the
controller to read, which came back as `ERR:GOTOJ` and no motion.** Palette-only fix — no
controller reflash, no flow edit. `MODULE_VERSION` stays `2.6.2` and the version handshake
(major.minor) is unaffected.

RAPID's `string` type holds **80 characters**, and `MainModule.mod` reads every socket request
into a single one (`SocketReceive clientSocket \Str:=rxStr`). A longer line is truncated at 80 on
the controller before any parsing happens.

goto is the only command that gets near that: 11 numbers, and the JSON framing
`{"cmd":"gotoj","val":[…]}` costs 24 characters before a single digit. Real GoFa 12 targets
serialize to **81–83 characters**, and the worst case inside the arm's reach is ~91 — the JSON
form of this command could never fit. Truncation cut the closing `]}`, `GetJsonNumArray` found no
`]`, and the controller answered `{"status":"err","cmd":"gotoj","msg":"invalid target"}`, which
the palette surfaces as `ack: "ERR:GOTOJ"`.

Why it looked point-specific rather than broken-everywhere: the overrun depends on how many
digits the point's coordinates happen to need. A point at 81 characters loses only its `}` and
still parses (the `]` survives at position 80); at 82+ the `]` goes and it fails. Of three points
taught for the Pick & Place Sorting Flow, "Pickup" landed on 81 and worked while "Bin A" and
"Bin B" landed on 83 and did not — so the flow reached the pickup and failed at both bins,
looking like a bin problem.

The fix is on the palette side: a goto request is emitted as JSON when it fits, and downgraded to
the legacy text token (`GOTOJ<x;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx>`) when it doesn't. That token
carries the same 11 numbers in **62–72 characters** because its framing is 5 instead of 24, and
`TryGoTo` in `MainModule.mod` parses it into the same `robtarget` and acks the same `OK:GOTO`.
The worst reachable target is 72 characters, so no target the robot can physically reach can
overrun any more. Every other command's JSON stays well under the limit and is untouched.

---

## 2.6.2 — DI Read also reads digital outputs

**`gofa-di-read` now reads DO signals as well as DI, and lists both in the Known Signals
dropdown.** No migration needed — the node type, its input, and its existing output fields are
unchanged.

The read path was always type-agnostic: `GET /rw/iosystem/signals/<name>` returns the same
`name`/`type`/`lvalue` shape for every signal kind, so a DO name typed into the Signal field
already worked. What changed is that outputs are now *offered*: the dropdown's `type === 'DI'`
filter became `['DI','DO']`, and the list is grouped into **Digital Inputs** and **Digital
Outputs** optgroups — with 51 DI and 45 DO on a typical Scalable I/O controller, a flat list made
it easy to pick an output while meaning to pick an input.

Reading a DO reports its current state and never writes it; `gofa-do-write` is still the only way
to change one.

`msg.payload` gains a **`type`** field (`'DI'`, `'DO'`, `'GO'`, … — whatever the controller
reports, never inferred from the signal name):

```js
{ ok: true, signal: 'ABB_Scalable_IO_0_DO1', value: 0, type: 'DO' }
```

This is additive; flows reading `payload.value` are unaffected.

Group outputs (GO) are deliberately *not* listed in the dropdown but remain readable by typing the
name. Analog signals are not listed either, because the value is parsed with `parseInt` and a float
reading would be silently truncated.

Internally, the runtime handler and the editor panel's **Read Value** button now share one
`readSignal()` implementation instead of holding two copies of the same read-and-parse logic.

**Also in this release:** new maintainer doc [`docs/transport-internals.md`](docs/transport-internals.md)
— how the socket and RWS layers actually work end to end (session/auth state machine, the
connection-per-command lifecycle, RAPID's hand-rolled JSON scanning, XHTML responses, WebSocket
subscription traps, and the node/admin-route pattern). No behavior change.

`MODULE_VERSION` in the three `rapid/*.mod` files is bumped to 2.6.2 in lockstep for provenance.
**The socket protocol did not change**, and the runtime handshake compares `major.minor` only, so a
controller still running a 2.6.x module reads as a match and does *not* need re-flashing.

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

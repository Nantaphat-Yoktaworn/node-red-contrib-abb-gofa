# Merged jog node (`gofa-jog`, 2.6.0)

`gofa-joint-jog` removed, folded into `gofa-jog` as extra entries on the existing
axis dropdown — now labelled **Target** — by direct user request. Second merge of
this shape after the five-into-one `gofa-points` merge at 2.5.0
(`docs/points-system.md`), and it follows that one's precedent: **replace, not
alias.** The node type is gone, not shimmed.

## Why not an Action dropdown

`gofa-points` needs an `action` field because save/go/list/delete/export/import
take genuinely different parameters. Jog doesn't — both old nodes took exactly
`(selector, dir, step)` and differed only in which socket command they emitted.
An "Action: Cartesian | Joint" selector would have been a redundant click whose
only job was choosing which *other* dropdown to read. So the target selector
carries the mode instead:

| Target | Frame / units | Clamp | Wire command |
|--------|---------------|-------|--------------|
| `X` `Y` `Z` | base frame, mm | 1–50 | `{cmd:'jog', axis:'X', sgn, val, rot:false}` |
| `RX` `RY` `RZ` | tool frame, deg | 1–30 | `{cmd:'jog', axis:'X', sgn, val, rot:true}` |
| `J1`–`J6` | joint, deg | 1–30 | `{cmd:'jointjog', joint:3, sgn, val}` |

Note the rotation row: the wire command takes the **bare axis letter plus a
`rot` flag**, never the `RX`/`RY`/`RZ` spelling — `RY` goes out as
`{axis:'Y', rot:true}`. That translation was the one non-obvious piece of the
old `gofa-jog` worth preserving verbatim, and it now has a direct unit test.

**No RAPID change.** `MainModule.mod` already had separate `jog` and `jointjog`
handlers with their own `JOG_MAX_MM` / `JOG_MAX_DEG` / `JOINT_MAX_DEG` clamps;
the merge is purely a Node-RED-layer change. The palette-side clamps are a
courtesy (a predictable status-bar token), not the safety boundary — the
controller clamps again regardless.

## `nodes/lib/jog.js`

The real motivation. Before the merge this algorithm existed in **four**
near-copies: two runtime handlers plus two admin routes. That is precisely the
duplication shape the 2026-08-04 audit blamed for bugs 2 and 3 ("the fix landed
in only one of two copies"), and it had already produced one live inconsistency
— `gofa-joint-jog` rejected a lowercase `j1` (its `String(joint).replace('J','')`
parse only stripped an uppercase `J`) while `gofa-jog` accepted a lowercase
`ry` via `toUpperCase()`. `resolveJog()` uppercases first, so both work now.

Deliberately preserved from the old parser: a **bare number or numeric string**
(`3`, `'3'`) is still accepted as the joint shorthand, because
`parseInt(String(joint).replace('J',''))` accepted it and the old help text
documented "a bare `1`–`6`".

## Back-compat

Two separate paths, both live-verified:

- **Payload aliases** — `msg.payload.axis` (old `gofa-jog`) and
  `msg.payload.joint` (old `gofa-joint-jog`) are still read, via
  `pickTarget()`. Precedence is `target` → `axis` → `joint`.
- **Stored config** — a `gofa-jog` node saved before 2.6.0 has `config.axis`
  and no `config.target`. The runtime falls back (`config.target ||
  config.axis || 'X'`), and the editor declares `axis` as a legacy default so
  `oneditprepare` can migrate it into the Target select; `oneditsave` then
  clears it so the two fields can never disagree.

There is **no** editor-side migration for `gofa-joint-jog`, because a removed
node type never reaches `oneditprepare` — Node-RED renders it as an unknown
node. External flows must be edited: change `"type"` to `"gofa-jog"` and rename
the `"joint"` field to `"target"`. Both bundled demo flows (`flows/` and
`examples/`) were migrated that way in the same commit.

## Live verification (2026-08-04, robot at `192.168.20.43`)

20/20 checks against the real controller, speed capped to 20%, every move paired
with its exact inverse. Drove the real `nodes/gofa-jog.js` through a minimal RED
mock, so both the deployed-node path and the editor admin route were exercised,
not just the resolver:

- Cartesian `X±10`, rotation `RZ±5`, single joint `J6±5` — runtime path
- legacy `payload.axis` (`Z±10`) and `payload.joint` (`J5±5`) aliases
- a legacy node built with `config.axis` and no `config.target` (`Y±10`)
- admin route `X±10` and `J4±5` (the editor's "Jog Now" button)
- rejections (`BOGUS`, `J7`, `J9`) confirmed to stop before the socket — the
  runtime returns `{ok:false, error}`, the admin route `400`

Arm returned to the start pose within 0.117° on the worst joint (J4), the rest
at 0.00–0.01°. The residual is jog rounding, not drift.

---
name: project-docs-audit-2026-07-17
description: "Full doc/help-text/flow accuracy audit (2026-07-17, day after the background-services generalization) — used agy in parallel for the 43-node help-text audit + 5 top-level doc audits; found and fixed real stale-doc bugs (not just cosmetic) plus a real flow-sync gap; removed JSON_SOCKET_TRANSITION.md and a stale todo draft"
metadata: 
  node_type: memory
  type: project
  originSessionId: 89dfabe3-80d8-495a-9391-c191673a3f34
---

Follow-on to [[project_background_services_task]] — the user asked to verify all flows work and
represent the current version, all node help text matches actual behavior, all repo docs match
the actual project, and to clean up what's no longer needed — explicitly asking to use `agy` to
divide the workload.

## Method

Split into parallel `agy` background calls (`Gemini 3.1 Pro (High)`, `--print-timeout 9m`):
- 6 groups of ~7 nodes each, comparing every node's `.html` help text against its `.js`
  implementation (same proven pattern documented in the `agy` skill's "Splitting one big review
  into N parallel calls" section).
- 5 more calls for top-level docs: root `README.md`; package `README.md` + `MANUAL_CONTROL.md`
  together; `abb-rws.md`; `omnicore-c30.md`; `crb15000.md`+`mastership-test.md`+`robot-status.md`
  together.
- Meanwhile did the flow-file audit and `CLAUDE.md` self-audit directly (not delegated) — flows
  needed actual judgment about JSON structure/config-field currency, and `CLAUDE.md` was already
  fully in context from the same-day background-services work.

**Every agy finding was independently re-verified against the actual code before applying** —
per the skill's own "OK is not exhaustive" caution, also spot-checked a few "no issues found"
files myself and found one real thing agy missed (see below).

## Real bugs found (not cosmetic — these would have actively misled a user)

- **`gofa-egm.html`**: claimed an unrecognized `msg.payload.action` falls back to the configured
  default; it actually throws a clear error (there's even an existing test for this exact
  behavior — the doc was just wrong).
- **`gofa-jog`/`gofa-joint-jog`/`gofa-go-point`/`gofa-move`**: all four claimed a rejected socket
  command returns `{ok:false, error:"..."}`; the actual shape is `{ok:false, ack:"..."}` (plus
  node-specific extra fields) — no `error` field at all in that case, confirmed by reading each
  `.js` file directly.
- **`gofa-rapid-exec.html`**: described the node as catching an RWS 403 from `loadmod`/
  `unloadmod`/`activate` and surfacing its reason text. The code was since changed to check
  `ctrlexecstate` proactively and throw its own error *before* ever calling RWS — the doc
  described genuinely dead code.
- **`gofa-rapid-var-write.html`**: example error string was `ERR:UNKNOWN_VAR...`; the code's own
  comment says the JSON wire protocol collapses every reason into a generic `ERR:SETVAR` — this
  was already known/commented in the code, just never fixed in the docs.
- **`gofa-robot.html`**: claimed on-robot (remote) saved points have no concurrent-write
  protection, unlike local points — false, `warnIfRemoteChanged()` gives the same best-effort
  changed-on-disk warning as the local path.
- **`MANUAL_CONTROL.md`** (caught by ME, not agy — agy reported this file "OK"): stated that
  touching the ASI LED needs `T_ROB1`/RAPID running. That's now actively wrong — the entire
  point of `BackgroundLed.mod`/`T_LED` (built the day before) is that LED control and `setdo`
  work over a separate port (1026) **without** `T_ROB1` running. Added a full "Part C" section
  documenting that port's JSON-only protocol. This is the concrete instance of the skill's "OK
  is not exhaustive" warning — a short, confident, wrong factual claim that a full-file "no
  issues" verdict didn't catch.
- **`omnicore-c30.md`**: said "3 RAPID tasks" in four places and was missing `T_LED` from both
  task tables entirely — written before `T_LED` existed (same-day-earlier work), never updated.
- **`README.md`** (root): missing `setup_flow.json`/`pickplace_sorting_flow.json` from two
  listings, missing `backgroundPort`/Remote Points Path from the config table, missing the new
  Background transport option for `gofa-do-write` in two places.
- **`abb-rws.md`**: two stale references to `gofa-ao-write.js`, a node removed 2026-07-07 for
  having no analog I/O on this controller.

## A real flow bug, not just a doc bug

**`node-red-contrib-abb-gofa/examples/teach_workflow_flow.json` (npm-shipped copy) was silently
missing a `transport: "background"` field that `flows/teach_workflow_flow.json` (source of
truth) already had** — confirmed via node-by-node deep-equal diff, not just eyeballing. This had
been sitting as an *uncommitted* working-tree change for some number of prior sessions (visible
at the very start of this conversation as a pre-existing, unexplained modified file) — nobody
had connected it to "the sync is actually broken," it just looked like stray uncommitted work.

**Root cause**: unlike `rapid/*.mod` (which has both a documented sync rule in `CLAUDE.md` *and*
a byte-identical drift test in `test.js`), `flows/` → `examples/` had no equivalent test — only
a narrower check for `outputPayload:true`. Added
`example flows: examples/ (npm copy) matches flows/ (source of truth), except gofa-robot
ip/username` to `test.js` — deep-equal per node, with the one legitimate exception (the
`gofa-robot` config node's `ip`/`username` are intentionally genericized for the public npm
release, confirmed as the only difference across all 4 flow pairs before writing the test).

## Cleanup done (with explicit user sign-off on all three)

- Deleted `JSON_SOCKET_TRANSITION.md` (root, tracked file) — a migration tracker doc marked
  "100% already shipped" since 2026-07-16; pure historical clutter at the repo root.
- Trimmed two stale `.gitignore` whitelist lines (`flows/dashboard_flow.json`,
  `flows/gofa_payload_test_flow.json`) — neither file exists on this branch.
- Deleted `ideas/todo-draft1.md` — explicitly superseded by `todo-draft2.md`'s own text
  ("Revised from todo-draft1.md..."). `ideas/` is entirely gitignored/untracked, so this was a
  local-only cleanup, not a repo history change.
- Marked `ideas/background-services-task-plan.md` (also untracked) as
  `STATUS: IMPLEMENTED + LIVE-VERIFIED` at the top rather than deleting it — it's the plan for
  [[project_background_services_task]], worth keeping as design history per this project's own
  convention for `.claude/plans/`.
- Noted partial progress on `ideas/improvement-roadmap.md`'s item #2 (self-healing watchdog) —
  the diagnostic groundwork (`gofa-connection-status`'s background check) is done, the actual
  auto-recovery flow wiring still isn't.

271/271 tests passing after all fixes. Nothing pushed — commit still pending as of this memory.

---
name: project_brake_check_reminder_flow
description: Cyclic Brake Check reminder flow built and live-tested 2026-07-24 — detects ABB elog code 90543, read-only by design; also fixed a stale NNNN username bug found across 6 example flows
metadata:
  type: project
---

Built `flows/brake_check_reminder_flow.json` (+ genericized `examples/` copy) after scoping it
in the previous conversation turn. Full technical detail is in `CLAUDE.md`'s "Cyclic Brake Check
reminder flow" section — this memory is the "why/what happened" companion.

**Why this exists**: reading the CRB 15000 manual this session surfaced a real safety-maintenance
requirement (Cyclic Brake Check every 8–48h, or the holding-brake rating degrades from PL d to
PL c) that nothing in the palette tracked. Checking this lab's actual robot found it wasn't
hypothetical — the elog already had three real "Cyclic Brake Check needs to be done" warnings
(code `90543`, domain 9/Safety), most recently from that morning's boot.

**Design is pure wiring, zero new node code** — `gofa-elog`/`gofa-subscribe-elog` already expose
`code` and already have Domain/Min-Severity filters, so this needed no `.js`/`.mod` changes.
Poll branch (`gofa-elog`, fires on deploy + every 6h) finds/reports the most recent matching
warning; subscribe branch (`gofa-subscribe-elog`) catches new occurrences live going forward.

**Deliberately read-only** — does not trigger the Cyclic Brake Check itself. The CRB 15000
manual says it's "run in the application" (RAPID-callable), so it's plausibly automatable via a
new socket command, but that needs the SafeMove Application manual (`3HAC066559` — referenced
by name in other manuals but not yet obtained) plus a supervised live motion test. Explicitly
deferred, noted in `ideas/improvement-roadmap.md`.

**Real limitation documented, not glossed over**: the warning appears to only get (re-)logged at
controller/RAPID start (inferred from timestamps lining up with known boot events), not
continuously — so the poll branch is re-reading history, and the subscribe branch only catches
NEW entries after it connects (same change-only behavior as every other `gofa-subscribe-*` node
here). A robot that runs for weeks without restarting could go newly-overdue with no fresh log
entry to catch it. Written into the flow's own "Limitation" comment node, not just this memory.

**Live-tested 2026-07-24**, driving the real node files (not curl, not a reimplementation — the
flow's actual function-node source strings, executed verbatim) via the same fake-RED harness
`test.js` uses, against the real robot: poll branch found all 3 real `90543` entries and picked
the correct most-recent one; subscribe branch connected cleanly and was torn down cleanly
(confirmed via a follow-up `GET /subscription` showing nothing orphaned). `node test.js` also
run clean (303/0) — the flow passes the drift check (`examples/` matches `flows/` except
`gofa-robot` ip/username) and the outputPayload-enabled check.

**Bonus bug found and fixed in the same pass**: 6 of the repo's 7 `flows/*.json` files
(`egm_conveyor_demo_flow`, `gofa_demo_flow`, `mqtt_bridge_flow`, `pickplace_sorting_flow`,
`teach_workflow_flow`, `watchdog_flow`) still had `username: "NNNN"` baked into their
`gofa-robot` config node — stale since the `NNNN` account was deleted from the controller
2026-07-22 (see [[user_robot_credentials]] — external memory only, scrubbed from the public
repo). Any of these would 401 if deployed as-is. Fixed to `"Admin"` in all six.
`flows/setup_flow.json` was deliberately left alone — it was never `NNNN`, its
`"Default User"`/stale-subnet IP is an intentional customize-me template for a fresh
Remote-Start/Stop role, not this lab's live config.

**How to apply**: if this flow's "overdue" status is ever wrong or stale-looking, check whether
the controller has actually restarted recently — the detection mechanism only refreshes at
boot, per the limitation above, not a bug to chase. If a future session tackles actually
triggering the Cyclic Brake Check remotely, start by getting `3HAC066559` (SafeMove Application
manual) rather than guessing RAPID syntax.

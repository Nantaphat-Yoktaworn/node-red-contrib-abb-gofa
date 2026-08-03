# Cyclic Brake Check reminder flow (added 2026-07-24)

**Problem solved**: CRB 15000 manual requires the Cyclic Brake Check (CBC) every 8–48h or the holding-brake safety rating degrades PL d → PL c. Nothing tracked this. Confirmed currently true on this lab's robot: `GET /rw/elog/9` (Safety domain) already had 3 real "Cyclic Brake Check needs to be done" entries (code `90543`, warning), most recent from that morning's boot.

**`flows/brake_check_reminder_flow.json`** — pure detection, no new `.js`/`.mod` code. **Poll branch** (on deploy + every 6h): `gofa-elog` (Domain Safety, Min Severity Warning) → `function` filtering `code==='90543'`, sorting by `tstamp` desc → `debug` + extension-point `comment`. **Subscribe branch**: `gofa-subscribe-elog` (same filter) → filter → `debug`, for new occurrences going forward.

**Read-only by design — does not trigger the check itself.** The check is plausibly automatable via a new RAPID socket command, but needs the SafeMove Application manual (`3HAC066559`, not yet read in this project) plus a supervised live test since it's real-motion safety code. Deliberately out of scope.

**Documented limitation**: the warning is (re-)logged at controller/RAPID start, not continuously while running (inferred from timestamp correlation, not ABB docs — re-confirm if revisited) — poll branch reads history, not live status; a robot running for weeks without restart might not log a fresh entry when newly overdue. Subscribe branch only catches entries logged after it subscribes (same as every other subscribe node here).

**Confirmed live**: poll branch found all 3 real entries, picked the correct most-recent one; subscribe branch connected/tore down cleanly.

**Same-session cleanup**: found 6 `flows/*.json` files still had stale `username: "NNNN"` (deleted from the controller 2026-07-22) — fixed to `"Admin"`. `examples/` copies already used `"Default User"` and were untouched (the one intentional `flows/`-vs-`examples/` difference the drift test allows).

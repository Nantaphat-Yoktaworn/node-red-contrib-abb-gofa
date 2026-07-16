# JSON Socket Protocol Transition: Node-RED & RAPID

This document outlines the progress and objectives of transitioning the ABB GoFa Node-RED palette from legacy string tokens (e.g. `PING`, `MOVEJ10;20;...`) to a structured JSON-over-TCP protocol on socket port `1025`.

---

## 1. Core Goal
* **Reshape All Node Outputs**: Reshape the output of all individual Node-RED nodes so that they construct and pass JSON objects directly to `socketSend` (e.g., `{ cmd: 'ping' }` or `{ cmd: 'movej', val: [...] }`), instead of constructing and translating legacy string tokens. **Done as of §4 below** — the `translateToJSON()` string-token layer stays permanently, though, since it's what keeps raw telnet/curl commands (`MANUAL_CONTROL.md`) working; it just isn't in the hot path for any shipped node anymore.

---

## 2. Current Status: Both phases complete (re-verified 2026-07-16)
* **Wire Protocol**: The RAPID server now handles incoming JSON structures and replies in JSON (e.g. `{"status":"ok","cmd":"ping"}`).
* **Backward Compatibility**: 100% intact. An old Node-RED client sending string tokens will trigger the RAPID server's string parser fallback. A new Node-RED client connecting to an old RAPID server will automatically handle legacy string replies.
* **Network Auto-Discovery**: Implemented and verified via RWS scanning.
* **Phase 2 (node refactor, see §4 below)**: also done — every node listed there now calls
  `socketSend()` with a structured object, confirmed by re-reading every file's current
  `socketSend(` call sites. `translateToJSON()` in `gofa-robot.js` still exists and still
  converts legacy string tokens for backward compatibility (raw curl/telnet per
  `MANUAL_CONTROL.md`, and any external client), but no shipped node relies on it anymore.

For the standalone testing scripts this doc originally referenced (which lived in an
agent scratch directory, not this repo), use `check-status.js` and `mastership-test.js`
in `node-red-contrib-abb-gofa/` instead — see the `/robot-status` and `/mastership-test`
skills in `CLAUDE.md`.

---

## 3. Lessons Learned (Crucial RAPID Details)
* **Array Dimensions Mismatch**: The custom RAPID `ParseNums` routine expects the number of elements in the incoming JSON array to match the target array size *exactly*.
  * *Fix*: Declared separate variables of explicit sizes (`jointVals{6}` for `movej` joints and `ledVals{4}` for `setled` settings) at the top of `DispatchJson` instead of reusing a single large `vals{11}` array.
* **`StrFind` vs `StrMatch`**: In RAPID, `StrFind` acts like `strpbrk` in C (searches for *any single character* in the search string set). Because all keys were wrapped in double quotes, `StrFind` always matched the very first double quote in the JSON string (index 2), erroneously matching `"cmd"` for every key.
  * *Fix*: Replaced all occurrences of `StrFind` with `StrMatch` (which performs a proper multi-character substring search) and updated bounds checking from `= 0` to `> StrLen(json)`.

---

## 4. Phase 2 (Refactoring Node-RED Nodes) — DONE, re-verified 2026-07-16

Originally a roadmap; every item below was checked against the current file and confirmed
already sending the structured object, not the legacy string token:

1. **`gofa-ping.js`** — `socketSend({ cmd: 'ping' })` ✅
2. **`gofa-stop-motion.js` / `gofa-stop-seq.js` / `gofa-leadthrough.js`** — `socketSend({ cmd: 'stop' })` ✅
3. **`gofa-speed-set.js`** — `socketSend({ cmd: 'speed', val: speed })` ✅
4. **`gofa-zone-set.js`** — `socketSend({ cmd: 'zone', val: zone })` ✅
5. **`gofa-rapid-var-read.js`** — `socketSend({ cmd: 'getvar', name: variable })` ✅
6. **`gofa-rapid-var-write.js`** — `socketSend({ cmd: 'setvar', name: variable, val: value })` ✅
7. **`gofa-egm.js`** — `socketSend({ cmd: 'egmjoint' })` / `socketSend({ cmd: 'ping' })` ✅
8. **`gofa-jog.js`** — `socketSend({ cmd: 'jog', axis, sgn, val, rot })` ✅
9. **`gofa-joint-jog.js`** — `socketSend({ cmd: 'jointjog', joint, sgn, val })` ✅
10. **`gofa-move.js`** — `socketSend({ cmd: cmd.toLowerCase() })` (`home`/`sethome`) ✅. `gofa-do-write.js`'s `setdo` transport is likewise `{ cmd: 'setdo', name, val }` ✅
11. **`gofa-movej.js`** — `socketSend({ cmd: cmdName, val: jointsArray })` ✅
12. **`gofa-go-point.js` / `gofa-sequencer.js`** — both pass `robot.gotoObj(...)`'s return value, a `{ cmd: 'gotoj'|'gotol', val: [...] }` object, straight into `socketSend` ✅
13. **`gofa-asi-led.js`** — `socketSend({ cmd: 'setled', val: [r,g,b,period] })` / `socketSend({ cmd: 'resetled' })` ✅

`translateToJSON()` in `gofa-robot.js` is kept — it's what lets raw legacy string tokens
(`PING`, `GOTOJ...`) sent by hand (`MANUAL_CONTROL.md`, a naïve external client) keep working —
but no node in this package constructs a legacy string token anymore.

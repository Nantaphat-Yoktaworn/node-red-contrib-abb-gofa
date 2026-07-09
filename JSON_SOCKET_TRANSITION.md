# JSON Socket Protocol Transition: Node-RED & RAPID

This document outlines the progress and objectives of transitioning the ABB GoFa Node-RED palette from legacy string tokens (e.g. `PING`, `MOVEJ10;20;...`) to a structured JSON-over-TCP protocol on socket port `1025`.

---

## 1. Core Goal
* **Reshape All Node Outputs**: The final objective is to reshape the output of all individual Node-RED nodes so that they construct and pass JSON objects directly to `socketSend` (e.g., `{ cmd: 'ping' }` or `{ cmd: 'movej', val: [...] }`), instead of constructing and translating legacy string tokens. This allows us to retire the translation layer entirely in a future release.

---

## 2. Current Status (Phase 1: Complete & Verified)
* **Wire Protocol**: The RAPID server now handles incoming JSON structures and replies in JSON (e.g. `{"status":"ok","cmd":"ping"}`).
* **Backward Compatibility**: 100% intact. An old Node-RED client sending string tokens will trigger the RAPID server's string parser fallback. A new Node-RED client connecting to an old RAPID server will automatically handle legacy string replies.
* **Network Auto-Discovery**: Implemented and verified via RWS scanning.

### How to Test / Run Diagnostics
We created several utility scripts under the agent's brain directory (`C:\Users\anapa\.gemini\antigravity-cli\brain\<conv-id>\scratch\`) to automate common tasks:
1. **Upload Module**: `node scratch/upload-module.js`
   Reads `rapid/MainModule.mod`, patches the `SERVER_IP` constant to the target controller's IP (`192.168.20.14`), and uploads it to `$HOME/Programs/MainModule.mod`.
2. **Reload & Restart**: `node scratch/reload-program.js`
   Stops RAPID execution, loads/replaces the module in the `T_ROB1` task, resets the Program Pointer (PP) to `main()`, and starts RAPID execution.
3. **Debug Socket**: `node scratch/debug-jog.js`
   Sends a raw JSON command (e.g. `{"cmd":"jog","axis":"X","sgn":"+","val":20,"rot":false}`) directly to the robot's TCP socket on port `1025` and outputs the raw response.

---

## 3. Lessons Learned (Crucial RAPID Details)
* **Array Dimensions Mismatch**: The custom RAPID `ParseNums` routine expects the number of elements in the incoming JSON array to match the target array size *exactly*.
  * *Fix*: Declared separate variables of explicit sizes (`jointVals{6}` for `movej` joints and `ledVals{4}` for `setled` settings) at the top of `DispatchJson` instead of reusing a single large `vals{11}` array.
* **`StrFind` vs `StrMatch`**: In RAPID, `StrFind` acts like `strpbrk` in C (searches for *any single character* in the search string set). Because all keys were wrapped in double quotes, `StrFind` always matched the very first double quote in the JSON string (index 2), erroneously matching `"cmd"` for every key.
  * *Fix*: Replaced all occurrences of `StrFind` with `StrMatch` (which performs a proper multi-character substring search) and updated bounds checking from `= 0` to `> StrLen(json)`.

---

## 4. Phase 2 Roadmap (Refactoring Node-RED Nodes)
Refactor the following files in `nodes/` that invoke `node.robot.socketSend(token)` to send structured JSON objects directly:

1. **`gofa-ping.js`**
   * *Current*: `socketSend('PING')`
   * *Target*: `socketSend({ cmd: 'ping' })`
2. **`gofa-stop-motion.js` & `gofa-stop-seq.js` & `gofa-leadthrough-enable.js`**
   * *Current*: `socketSend('STOP')`
   * *Target*: `socketSend({ cmd: 'stop' })`
3. **`gofa-speed-set.js`**
   * *Current*: `socketSend('SPEED' + speed)`
   * *Target*: `socketSend({ cmd: 'speed', val: speed })`
4. **`gofa-zone-set.js`**
   * *Current*: `socketSend(cmd)` (where `cmd` is `ZONE<val>`)
   * *Target*: `socketSend({ cmd: 'zone', val: zone })`
5. **`gofa-rapid-var-read.js`**
   * *Current*: `socketSend('GETVAR:' + variable)`
   * *Target*: `socketSend({ cmd: 'getvar', name: variable })`
6. **`gofa-rapid-var-write.js`**
   * *Current*: `socketSend('SETVAR:' + variable + ':' + value)`
   * *Target*: `socketSend({ cmd: 'setvar', name: variable, val: value })`
7. **`gofa-egm.js`**
   * *Current*: `socketSend('EGMJOINT')` / `socketSend('PING')`
   * *Target*: `socketSend({ cmd: 'egmjoint' })` / `socketSend({ cmd: 'ping' })`
8. **`gofa-jog.js`**
   * *Current*: `socketSend(token)` (where `token` is `R?X|Y|Z[+-]val`)
   * *Target*: `socketSend({ cmd: 'jog', axis: axis, sgn: sgn, val: val, rot: rot })`
9. **`gofa-joint-jog.js`**
   * *Current*: `socketSend(token)` (where `token` is `J[1-6][+-]val`)
   * *Target*: `socketSend({ cmd: 'jointjog', joint: joint, sgn: sgn, val: val })`
10. **`gofa-move.js`**
    * *Current*: `socketSend(cmd)` (where `cmd` is `GOTOL...` or `GOTOJ...`)
    * *Target*: `socketSend({ cmd: linear ? 'gotol' : 'gotoj', val: poseArray })`
11. **`gofa-movej.js`**
    * *Current*: `socketSend(cmd)` (where `cmd` is `MOVEJ...`)
    * *Target*: `socketSend({ cmd: 'movej', val: jointsArray })`
12. **`gofa-go-point.js` & `gofa-sequencer.js`**
    * *Current*: Pass calculated token strings
    * *Target*: Pass structured objects matching `gotoj`/`gotol`/`movej` schema.
13. **`gofa-asi-led.js`**
    * *Current*: `socketSend('SETLED:r;g;b;period')` / `socketSend('RESETLED')`
    * *Target*: `socketSend({ cmd: 'setled', val: [r, g, b, period] })` / `socketSend({ cmd: 'resetled' })`

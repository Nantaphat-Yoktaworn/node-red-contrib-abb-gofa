# Plan: msg.payload Support Audit + Help + Release

## Context

The palette follows the pattern: **msg.payload → node property → default**. 28 of 39 nodes already implement this correctly. This plan fixes 6 nodes where the pattern is broken or incomplete, updates each node's HTML help text to document the payload API, then packages and documents the release.

**Working rule**: Finish one node (JS fix + HTML help) → stop → wait for user to say "continue" → next node.

---

## Checklist

### Phase 1 — Node fixes (JS + HTML help, one at a time)

- [ ] **gofa-motor** — bare-string payload + help
- [ ] **gofa-move** — bare-string payload + help
- [ ] **gofa-rapid-exec** — bare-string payload + help
- [ ] **gofa-points-export** — savePath from msg.payload + help
- [ ] **gofa-points-import** — loadPath from msg.payload + help
- [ ] **gofa-subscribe-pose** — interval override from msg.payload + help

### Phase 2 — Release tasks (after all 6 nodes done)

- [ ] Rebuild `.tgz` package
- [ ] Write / update `README.md`
- [ ] Update `/abb-rws` skill
- [ ] Update memory

---

## Node fix details (one node per session)

### 1. `nodes/gofa-motor.js` — add bare-string path

**JS change** — line 10, replace:
```js
var action = (msg.payload && msg.payload.action) || node.action;
```
with:
```js
var raw    = msg.payload;
var action = (typeof raw === 'string' && raw) ? raw
           : (raw && raw.action)              ? raw.action
           : node.action;
```

**HTML help** — in `gofa-motor.html`, add/replace the `<script type="text/html" data-help-name="gofa-motor">` section:
```
msg.payload accepted forms:
  • string   — 'motoron' or 'motoroff'
  • object   — { action: 'motoron' }
  • (absent) — uses Action dropdown value (default: motoron)

Output msg.payload: { ok: true|false, action: '...' }
```

---

### 2. `nodes/gofa-move.js` — add bare-string path

**JS change** — line 10, replace:
```js
var cmd = (msg.payload && msg.payload.command) || node.command;
```
with:
```js
var raw = msg.payload;
var cmd = (typeof raw === 'string' && raw) ? raw
        : (raw && raw.command)             ? raw.command
        : node.command;
```

**HTML help** — `gofa-move.html`:
```
msg.payload accepted forms:
  • string   — 'HOME' or 'SETHOME'
  • object   — { command: 'HOME' }
  • (absent) — uses Command dropdown value (default: HOME)

Output msg.payload: { ok: true|false, ack: '...' }
```

---

### 3. `nodes/gofa-rapid-exec.js` — add bare-string path

**JS change** — line 12, replace:
```js
var action = (msg.payload && msg.payload.action) || node.action;
```
with:
```js
var raw    = msg.payload;
var action = (typeof raw === 'string' && raw) ? raw
           : (raw && raw.action)              ? raw.action
           : node.action;
```

**HTML help** — `gofa-rapid-exec.html`:
```
msg.payload accepted forms:
  • string   — 'start', 'stop', or 'resetpp'
  • object   — { action: 'start' }
  • (absent) — uses Action dropdown value (default: start)

Output msg.payload: { ok: true|false, action: '...' }
Note: requires Remote Start/Stop UAS grant; resetpp also needs Edit mastership.
```

---

### 4. `nodes/gofa-points-export.js` — savePath from msg.payload

**JS change** — line 12, replace:
```js
var savePath = msg.savePath || node.savePath || '';
```
with:
```js
var raw      = msg.payload;
var savePath = (typeof raw === 'string' && raw) ? raw
             : (raw && raw.savePath)             ? raw.savePath
             : msg.savePath || node.savePath || '';
```

**HTML help** — `gofa-points-export.html`:
```
msg.payload accepted forms:
  • string   — file path to save to, e.g. '/data/points.json'
  • object   — { savePath: '/data/points.json' }
  • (absent) — uses "Save to file" property (empty = no file write)

Output msg.payload: { ok: true, count: N, points: [...], savedTo: path|undefined }
```

---

### 5. `nodes/gofa-points-import.js` — loadPath from msg.payload

**JS change** — lines 11–12, replace:
```js
var loadPath = msg.loadPath || node.loadPath || '';
var arr;
```
with:
```js
var loadPath;
if (typeof msg.payload === 'string' && msg.payload) {
    loadPath = msg.payload;
} else if (msg.payload && msg.payload.loadPath) {
    loadPath = msg.payload.loadPath;
} else {
    loadPath = msg.loadPath || node.loadPath || '';
}
var arr;
```

**HTML help** — `gofa-points-import.html`:
```
msg.payload accepted forms:
  • string     — file path to load from, e.g. '/data/points.json'
  • object     — { loadPath: '/data/points.json' }
  • array      — [...] point objects to import directly
  • { points } — { points: [...] }
  • (absent)   — uses "Load from file" property

Output msg.payload: { ok: true, count: N, loadedFrom: path|null }
```

---

### 6. `nodes/gofa-subscribe-pose.js` — interval override from msg.payload

**JS change** — replace the `node.on('input', ...)` handler (lines 48–53):
```js
node.on('input', function(msg, send, done) {
    if (!node.robot) { node.error('No robot configured', msg); return done(); }
    if (node._running) stopPolling();
    else startPolling();
    done();
});
```
with:
```js
node.on('input', function(msg, send, done) {
    if (!node.robot) { node.error('No robot configured', msg); return done(); }
    if (node._running) {
        stopPolling();
    } else {
        var raw = msg.payload;
        if (raw && typeof raw.interval === 'number') {
            node.interval = Math.max(100, Math.round(raw.interval));
        }
        startPolling();
    }
    done();
});
```

**HTML help** — `gofa-subscribe-pose.html`:
```
Input triggers start/stop toggle.

msg.payload accepted forms (on start only):
  • object   — { interval: 2000 } — override poll rate in ms (min 100)
  • (absent) — uses Interval property (default: 500 ms)

Output msg.payload (each poll): { ok: true, x, y, z, q1, q2, q3, q4 }
```

---

## Phase 2 — Release tasks

### Rebuild .tgz
```
cd node-red-contrib-abb-gofa
npm pack
```
Produces `node-red-contrib-abb-gofa-<version>.tgz` — copy to repo root.

### README.md
Update / create `README.md` at repo root with:
- What the palette does
- Installation
- Node list (one line each: name, transport, what payload accepts)
- Default connection settings table (already in CLAUDE.md)

### Update `/abb-rws` skill
Add a note on the 6 fixed nodes with their new payload API.

### Update memory
Save a project memory entry: "msg.payload audit done — 6 nodes fixed, palette version bumped."

---

## Nodes already correct (no changes needed)

gofa-jog · gofa-joint-jog · gofa-movej · gofa-speed-set · gofa-zone-set · gofa-grip · gofa-go-point · gofa-save-point · gofa-delete-point · gofa-rapid-var-read · gofa-rapid-var-write · gofa-do-write · gofa-ao-write · gofa-ai-read · gofa-di-read · gofa-file-read · gofa-upload-mod · gofa-sequencer · gofa-subscribe-var · gofa-elog · gofa-io-list · gofa-subscribe-io · gofa-points-import (partial fix above)

## Pure-trigger nodes (no payload needed)

gofa-status · gofa-pose · gofa-joints · gofa-system-info · gofa-ping · gofa-stop-motion · gofa-stop-seq · gofa-point-list · gofa-leadthrough-enable · gofa-leadthrough-disable

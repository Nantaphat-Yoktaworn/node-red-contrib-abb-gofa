# Plan: Sequencer Node Improvements

## Context

The `gofa-sequencer` and `gofa-stop-seq` nodes have four practical pain points:

1. **Stop isn't immediate** — `gofa-stop-seq` only sets `_seqStop = true`. The sequencer checks the flag only at the *start* of each step, so the robot finishes the current `\Conc` move *and* the full dwell timer before actually stopping. That can be 800 ms+ of unwanted motion.
2. **No loop count** — You can run once or loop forever; there's no "run N times then stop."
3. **No per-step dwell** — Every step waits the same number of ms. You can't park longer at a pick point vs. a transit point.
4. **No start-from-step** — The sequence always restarts from step 0. You can't resume mid-sequence or skip to a specific point.

---

## Changes

### 1. `gofa-stop-seq.js` — send STOP socket command immediately

```js
// After setting _seqStop = true, also fire STOP via socket to abort the in-progress \Conc move.
node.robot._seqStop = true;
node.robot.socketSend('STOP').catch(function() {});   // ignore if RAPID not reachable
```

The `.catch(() => {})` keeps it non-fatal (RAPID might already be idle).

---

### 2. `gofa-sequencer.js` — loop count + per-step dwell + start-from-step

**New config properties (with defaults for backward compat):**
- `count` (number, default `0` = infinite when `loop` is true, ignored when `loop` is false)
- Each step object gets an optional `dwell` field: `{ name, dwell }` — falls back to the node-level `dwell` if absent

**New `msg.payload` overrides (same priority pattern as all other nodes):**
- `msg.payload.count` — override loop count at runtime
- `msg.payload.startStep` — 1-based index to start from (e.g. `3` skips to step 3)
- Each step in `msg.payload.steps` can carry its own `dwell`: `{ name: 'pick1', dwell: 2000 }`

**Updated `runStep` logic:**
```js
// track loop iterations
var loopCount = 0;

function runStep(idx) {
    if (r._seqStop) { /* same as now */ return finish(); }
    if (idx >= cmds.length) {
        if (loop) {
            loopCount++;
            // count=0 means infinite; otherwise stop when loopCount reaches count
            if (count > 0 && loopCount >= count) {
                // done — fall through to finish
            } else {
                return runStep(0);
            }
        }
        // sequence complete
        node.status({ fill: 'green', shape: 'dot', text: 'done' });
        send([null, { payload: { done: true, loops: loopCount } }]);
        return finish();
    }
    var c = cmds[idx];
    var stepDwell = (c.dwell != null) ? c.dwell : dwell;   // per-step dwell
    node.status({ fill: 'blue', shape: 'dot',
        text: (idx + 1) + '/' + total + ' ' + c.name + (loop && count > 0 ? ' [' + (loopCount+1) + '/' + count + ']' : '') });
    r.socketSend(c.token).then(function(ack) {
        send([{ payload: { step: idx+1, total, name: c.name, ack, loop: loopCount+1 } }, null]);
        setTimeout(function() { runStep(idx + 1); }, stepDwell);
    }).catch(/* same as now */);
}

runStep(startStep);   // startStep = Math.max(0, (p.startStep || 1) - 1)
```

**Step resolution** — when building `cmds`, copy the per-step dwell from the step config:
```js
cmds.push({ name: pt.name, token: tok, dwell: steps[i].dwell != null ? steps[i].dwell : null });
```

---

### 3. `gofa-sequencer.html` — editor UI additions

**New fields in the template:**
- **Loop count** input (number, `0` = infinite) — only shown when Loop checkbox is checked (`$('#node-input-loop').change(...)` toggle)
- **Per-step dwell** — in `addItem`, add a second input next to the point select: a small number input (`placeholder="default"`, empty = use node dwell). Save as `dwell` in the step object.

**`defaults` additions:**
```js
count: { value: 0 }
```

**`addItem` row change:**
```html
[point-select dropdown]  [dwell input — 60px wide, placeholder "default"]
```

**`oneditsave` change:**
```js
steps.push({ name: v, dwell: dwellVal !== '' ? parseInt(dwellVal) : null });
```

**Loop count field visibility toggle:**
```js
$('#node-input-loop').change(function() {
    $('#loop-count-row').toggle(this.checked);
}).trigger('change');
```

---

## Files to modify

| File | What changes |
|------|-------------|
| `node-red-contrib-abb-gofa/nodes/gofa-stop-seq.js` | Add `socketSend('STOP')` after setting flag |
| `node-red-contrib-abb-gofa/nodes/gofa-sequencer.js` | Loop count, per-step dwell, startStep |
| `node-red-contrib-abb-gofa/nodes/gofa-sequencer.html` | Count field, per-step dwell input in editableList |

No RAPID changes needed — `STOP` command already exists and clears the motion queue.

---

## Verification

1. **Immediate stop**: Start a long sequence (large dwell), trigger `gofa-stop-seq` mid-dwell — robot should stop within one socket round-trip (~50 ms), not wait for the dwell timer.
2. **Loop count**: Set loop=true, count=3, trigger — sequencer should run through all steps exactly 3 times then emit `{ done: true, loops: 3 }` on output 2.
3. **Per-step dwell**: Set step A dwell=2000, step B dwell=200 in the editor — robot should pause ~2 s at A and ~200 ms at B.
4. **startStep**: Trigger with `msg.payload = { startStep: 2 }` — sequence should skip step 1 and begin at step 2.
5. **Backward compat**: Existing sequences (no per-step dwell, no count) should behave identically to before.

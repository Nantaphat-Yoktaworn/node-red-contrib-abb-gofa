# Stop hardcoding SERVER_IP in MainModule.mod

## Context

`rapid/MainModule.mod` binds its TCP socket server with:
```
CONST string SERVER_IP := "192.168.20.15";
SocketBind serverSocket, SERVER_IP, SERVER_PORT;
```
This has already caused a documented failure mode (see project memory `rws-omnicore-findings.md` #4): if the controller's IP changes and this constant isn't updated + re-uploaded, `SocketBind` **silently fails to bind** and every TCP command from Node-RED times out with no error surfaced on the controller side.

RAPID's `SocketBind` requires a real, already-configured interface address — it's not a raw BSD socket that accepts a wildcard/`0.0.0.0`. Since that's a hard constraint of the instruction itself, the fix isn't to change what `SocketBind` does — it's to stop requiring a human to keep the constant in sync by hand.

The project already has a single source of truth for the robot's IP: the `gofa-robot` config node's `ip` field, used for every RWS and socket connection today. `gofa-upload-mod` is the node that PUTs `MainModule.mod` to the controller — it already has `r.ip` in scope at upload time. So: patch `SERVER_IP` into the file content during upload, from that same config value. Re-uploading the module (something you already do whenever it changes) is what keeps it correct — no more manually editing the `.mod` source and remembering to match it to the config node.

## Approach

Extend `gofa-upload-mod` to rewrite the `SERVER_IP` constant in the uploaded content to match `node.robot.ip`, gated by a node option (default on) so the node still works unchanged for uploading files that don't declare `SERVER_IP`.

### `nodes/gofa-upload-mod.js`
- Add a pure, testable helper (same pattern as `gotoToken`/`parseXhtml` in `gofa-robot.js`):
  ```js
  function patchServerIp(text, ip) {
      var injected = false;
      var patched = text.replace(/(CONST\s+string\s+SERVER_IP\s*:=\s*")[^"]*(")/i, function(m, p1, p2) {
          injected = true;
          return p1 + ip + p2;
      });
      return { text: patched, injected: injected };
  }
  ```
  Export it at the bottom (`module.exports.patchServerIp = patchServerIp;`) for unit testing.
- Add `this.injectServerIp = config.injectServerIp !== false;` (default true) to the constructor.
- After `content` is finalized (after the `msg.payload` override handling and the disk-read fallback, before `body` is built): if `node.injectServerIp` and content is present, convert to text (`Buffer.isBuffer(content) ? content.toString('utf8') : String(content)`), run it through `patchServerIp(text, r.ip)`, and reassign `content` back (as a Buffer if it started as one). No match found → no-op, so uploading unrelated files is unaffected.
- Add `serverIpInjected: <bool>` to the success `msg.payload`, so it's visible in the flow output whether the substitution actually happened (e.g. flags a typo'd constant name).

### `nodes/gofa-upload-mod.html`
- Add a checkbox row, same style as `gofa-sequencer`'s `loop`/`pingpong`:
  ```html
  <div class="form-row">
      <label for="node-input-injectServerIp"><i class="fa fa-map-marker"></i> Inject IP</label>
      <input type="checkbox" id="node-input-injectServerIp" style="width:auto">
  </div>
  ```
  with `injectServerIp: { value: true }` in `defaults`.
- Update the help text to describe the new behavior and the `serverIpInjected` output field.

### `test.js`
Add unit tests for `patchServerIp` (no network mocking needed, same style as existing pure-function tests):
- replaces the quoted IP when the constant is present
- is case-insensitive on the `CONST`/`SERVER_IP` keywords
- leaves the rest of the file content untouched
- no-ops (returns `injected: false`, text unchanged) when the constant isn't present

(The HTTP PUT path itself stays untested, consistent with the rest of `gofa-robot.js`'s network calls — only the pure logic is covered.)

### Docs
- `CLAUDE.md`: note under the `gofa-upload-mod` table row (or a short new note near the RAPID socket protocol section) that it auto-syncs `SERVER_IP` to the config node's IP on every upload.
- `README.md`: add one sentence to the IP-change / troubleshooting section noting that re-uploading via `gofa-upload-mod` keeps `SERVER_IP` in sync automatically, so manual find-and-replace across the repo is only needed if you're not using that upload path.
- Update memory `rws-omnicore-findings.md` item 4 to record that this failure mode is now mitigated by `gofa-upload-mod`'s auto-injection (still note that a *first* upload or a manual FlexPendant SD-card load bypasses it, so the constant's default value should stay reasonably current).

## Verification
- `npm test` in `node-red-contrib-abb-gofa/` — new `patchServerIp` cases pass alongside the existing suite.
- Manual/hardware check (for you, not me — I can't run RAPID or hit the real controller from here): deploy a flow with `gofa-upload-mod` pointed at `rapid/MainModule.mod`, trigger it, and confirm `msg.payload.serverIpInjected === true` and that the uploaded file on the controller (via `gofa-file-read`) shows the config node's IP in `SERVER_IP`.

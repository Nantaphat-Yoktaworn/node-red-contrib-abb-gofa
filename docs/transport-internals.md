# Transport internals — how the two communication layers actually work

**Scope**: the *mechanism* of the socket and RWS transports, for someone about to change them.
Every claim here is anchored to a `file:line` so it can be re-checked against the code rather than
against this page.

This doc deliberately does **not** carry:

| You want | Read instead |
|----------|--------------|
| The list of commands/endpoints and what to send | [`MANUAL_CONTROL.md`](../MANUAL_CONTROL.md) — curl recipes, socket command table, port 1026 |
| Why a given command behaves oddly, and what was tried before | [`rapid-protocol-notes.md`](rapid-protocol-notes.md) — gotchas and bugfix history |
| What each node does and what `msg.payload` it takes | [`reference.md`](reference.md) |
| The architecture summary and quick-reference tables | `CLAUDE.md` (repo root) |

## The asymmetry that explains the whole design

Both layers talk to the same controller, but they are not peers:

- **RWS is ABB's.** Built into RobotWare, running whether or not any RAPID program exists. It reads
  everything and can switch motors on — but it **cannot move the arm to a pose you choose**. There
  is no "MoveJ here" endpoint; motion belongs to the RAPID program by design.
- **The socket server is ours.** `rapid/MainModule.mod` is our own program that happens to listen on
  a port. Stop RAPID and port 1025 is dead while RWS keeps answering telemetry cheerfully.

Hence the rule: **motion goes through the socket; read-only data and motor power go through RWS.**
It is a capability boundary, not a preference. The one place the palette deliberately crosses it is
`gofa-stop-motion`'s `immediate` mode, which stops motion via RWS *because* the socket cannot be
served mid-move (below, and in `rapid-protocol-notes.md`).

---

# 1. The socket transport (port 1025)

## 1.1 Server lifecycle

`main()` (`rapid/MainModule.mod:89`) loads the persisted home pose, then loops on `ServeForever`
(`:97`) forever, with `WaitTime 1` between attempts. `ServeForever` creates/binds/listens, then
blocks in `SocketAccept … \Time:=WAIT_MAX` and hands each accepted client to `ServeClient` (`:113`).

**Every socket fault tears the whole thing down and rebuilds it.** `ServeForever`'s `ERROR` handler
(`:106`) closes both sockets and returns, so `main`'s `WHILE TRUE` reconstructs the server from
scratch. That is why killing Node-RED, yanking the cable, or a mid-transaction reset never leaves a
permanently dead listener.

**`SocketBind` needs a literal address** — RAPID cannot bind a wildcard. That is the entire reason
`SERVER_IP` exists as a `CONST string` (`:57`) and why `nodes/lib/patch-server-ip.js` rewrites it on
every upload path. If the constant does not match a real configured interface, `SocketBind` throws,
the ERROR handler fires, and `main` retries a bind that can never succeed — port 1025 simply never
opens, with no obvious symptom beyond "socket unreachable".

> The repo copy of `MainModule.mod` currently carries `SERVER_IP := "192.168.1.103"`, which is
> historical. Harmless in practice (upload patches it), but do not read it as the robot's address.

## 1.2 One TCP connection per command

`socketSend()` (`nodes/gofa-robot.js:527`) connects, writes one `\n`-terminated line, reads until the
first `\n`, and destroys the socket. No pooling, no keep-alive, no reuse — every node action in the
palette opens a fresh connection. Client-side timeout is 5 s.

**Why that works is worth internalising.** By the time the client destroys the socket, the RAPID task
is often still executing the move. When it loops back to `SocketReceive`, the peer is gone →
`ERR_SOCK_CLOSED` → `SocketClose` + `RETURN` (`:128`) → back to `SocketAccept`. **The client
disconnect is the normal end of a transaction, not an error.** `ServeClient`'s `WHILE TRUE` exists
only to support a client that *does* hold the connection open (raw telnet, per `MANUAL_CONTROL.md`);
the palette never uses it for a second command.

**The consequence you will actually hit**: send a second command while a move is running and the
controller has not reached `SocketAccept` yet. The kernel's listen backlog accepts the TCP handshake,
so `connect` succeeds and the write lands in a buffer — and nothing answers until the move finishes.
Past 5 s the client reports `socket timeout` although nothing is broken. This is the signature
`flows/watchdog_flow.json` was built to distinguish from a genuine wedge.

## 1.3 Protocol selection is one byte

`ServeClient` reads the first character (`:119`): `{` → `DispatchJson` (`:245`), anything else →
the legacy uppercase text parser `Dispatch` (`:498`). No handshake, no version byte, no negotiation.

The legacy path runs `CleanCmd` (`:812`) first — drop every byte ≤ 0x20, uppercase the rest — then
falls through a chain of `Try*` predicates until one claims the token. It is kept **only** so the
robot is drivable from `telnet`/`ncat` while debugging; nothing in the palette emits it on the wire.
`TrySetVar` additionally receives `rawclean` (`StripCtrl`, `:887`, strips CR/LF only) so a string
value keeps its spaces and its original case.

## 1.4 There is no JSON parser on the controller

`DispatchJson` is fed a raw string and mines it with four hand-rolled `StrMatch` scanners
(`:142`–`:226`):

| Function | Technique |
|---|---|
| `GetJsonStringVal` (`:142`) | find `"key"`, then the next two `"` characters, take what is between |
| `GetJsonNumVal` (`:159`) | find `"key"`, next `:`, next `,` or `}`, `StrToVal` the slice |
| `GetJsonBoolVal` (`:181`) | same slice, uppercase-compare against `TRUE`/`FALSE` |
| `GetJsonNumArray` (`:210`) | find `[`…`]`, `NormalizeCommas` turns `,`→`;`, then `ParseNums` |

**The structural rules that fall out of this are protocol constraints, not style preferences:**

- **Flat objects only.** A nested object or array breaks `GetJsonNumVal`, which stops at the first
  `,` or `}` it meets.
- **A string value containing `,` `}` `[` or `]` corrupts parsing.** Nothing escapes anything.
- **Key order is irrelevant** — each getter scans from position 1 independently. A duplicated key
  silently takes the first occurrence.
- **Numeric arrays must fill their target exactly.** `ParseNums` returns `count = Dim(arr,1)`
  (`:767`), so 10 values where `gotoj` wants 11 is a clean `err`, never a partial move.
- **Case handling is per-handler, not global.** `getvar`/`setvar` uppercase the name via `StrMap`
  (`:459`, `:472`); `setdo`'s `TEST name` (`:431`) compares raw. So a lowercase variable name works
  and a lowercase signal name does not.
- **Signals and variables are allow-listed by name**, each as an explicit `CASE` (`:431`, `:457`).
  RAPID cannot resolve a runtime string into a signal or variable reference, so anything not compiled
  into that list returns `unknown signal` / `unknown var`. **Adding a signal means editing the `.mod`
  and re-flashing** — there is no dynamic path.

Replies are built by string concatenation (`ByteToStr(10\Char)` is the trailing `\n`), which is why
every `val` in a reply is quoted even when it is numeric.

## 1.5 `translateToJSON` — the bidirectional compatibility shim

Nodes still call `socketSend()` with legacy string tokens (`'PING'`, `'X+20'`, `'GETVAR:nTestVar'`).
`translateToJSON` (`gofa-robot.js:445`) converts each to the real JSON wire request, and the reply
handler (`:539`–`:586`) converts the JSON answer *back* into the legacy string shape
(`{"status":"ok","cmd":"ping"}` → `'OK:PING'`; `{"cmd":"getvar","val":X}` → `'VAL:X'`; any
`status:"err"` → `'ERR:<CMD>'`).

**Both directions matter.** The round trip is what lets every node keep doing `resp.startsWith('OK:')`
(e.g. `gofa-ping.js:17`) while the wire protocol underneath is JSON. An unrecognised string is passed
through untouched and lands in the legacy text parser on the controller.

Passing a **plain object** skips the translation entirely (`:446`) — that is the preferred form for
new code, and what `gofa-ping` and `gofa-stop-motion` already do.

## 1.6 The ack-before-move contract

Every motion handler sends its reply **before** executing the motion instruction — see `gotoj`
(`:342`), `movej` (`:365`), `jog` (`:386`), `jointjog` (`:399`), and the legacy `Try*` equivalents.

Three consequences that shape everything above this layer:

1. **`OK:` means "parsed, validated, accepted" — never "the arm arrived."** There is no completion
   event anywhere in this protocol. To know a move finished, poll `gofa-joints`/`gofa-pose`.
2. **A motion fault after the ack is invisible to the client.** It surfaces on the RAPID side at
   `ServeClient`'s ERROR handler, which does `StopMove; ClearPath; StartMove; RETRY` (`:135`) and
   keeps serving. The client already got its `OK:`. You find out via `gofa-elog` or `gofa-status`.
3. **The 5 s client timeout is survivable for a 30 s move**, because the ack returns in milliseconds.
   Remove the ack-first ordering and every long move breaks.

Move instructions run **without `\Conc`** (blocking); jogs still use it, preceded by
`StopMove; ClearPath; StartMove` so a stream of jog clicks cannot stack up. The reasoning, the
advance-run limit it avoids, and why mid-move `STOP` therefore needs RWS all live in
[`rapid-protocol-notes.md`](rapid-protocol-notes.md) — not repeated here.

**Safety clamps are enforced on the controller** (`JOG_MAX_MM` / `JOG_MAX_DEG` / `JOINT_MAX_DEG`,
`:73`–`:75`). `nodes/lib/jog.js:21` mirrors them so the status text is predictable, but that copy is
a courtesy, not the boundary — the controller re-validates every value and answers `err` out of
range. Keep it that way.

---

# 2. The RWS transport (HTTPS, port 443)

## 2.1 Session state machine

All of it lives in `createRobotClient` (`gofa-robot.js:245`), a RED-independent closure so
`check-status.js` and `mastership-test.js` can reuse it without a Node-RED runtime.

1. `getSession()` (`:317`) sees no cookie → `GET /rw/system` with forced Basic auth.
2. The response's `Set-Cookie` is captured, split at `;`, rejoined as `name=value; name=value`
   (`:288`).
3. Every later request sends `Cookie:` only (`:272`).
4. **A 401 with `forceAuth === false` nulls the cookie and retries the identical request with Basic**
   (`:295`). Controller sessions expire after roughly five minutes idle; this makes that invisible to
   every caller. `requestRaw` carries the same retry (`:401`) — it was added later, after nodes on
   the raw path hard-failed where every `rwsGet`-based node silently recovered.
5. `loginPromise` (`:319`) is a single-flight guard: ten nodes starting at once share one login round
   trip instead of racing ten.
6. `logout()` (`:429`) runs on node `close` (redeploy/stop). Best-effort, never throws, never
   re-authenticates. **Without it every redeploy leaked a session** until the controller's own idle
   timeout — and OmniCore allows only **19 concurrent sessions** once any WS subscription is active,
   after which the FlexPendant is locked out with "too many device login".

TLS is self-signed throughout, so every request carries `rejectUnauthorized: false`.

## 2.2 Content negotiation and its three exceptions

Defaults (`:271`, `:279`): `Accept: application/xhtml+xml;v=2.0`, and for POST/PUT
`Content-Type: application/x-www-form-urlencoded;v=2.0`. The `;v=2.0` suffix selects the RWS
protocol generation.

| Exception | Header | Why |
|---|---|---|
| `loadmod` / `activate` | `Accept: application/hal+json;v=2.0` — `rwsPostHal` (`:333`) | the only endpoints requiring it; everything else errors *"Server cannot generate response for given accept header"* |
| fileservice PUT | `Content-Type: text/plain;v=2.0` (`:679`) | `application/json` is rejected **415**, even for JSON content |
| binary / header access | `requestRaw` with `accept: '*/*'` (`:667`) | resolves `{statusCode, headers, body: Buffer, cookie}` instead of a decoded string |

Writes are form-encoded bodies (`ctrl-state=motoron`, `stopmode=stop&usetsp=normal`) and succeed with
an empty 2xx — read state back with a separate GET.

**Error bodies are mined for a human reason** (`:305`): `class="msg">…<` for xhtml, `"msg":"…"` for
hal+json, appended to the thrown message. That turns a bare `HTTP 403` into
`HTTP 403 /rw/rapid/execution/start — Operation not allowed for current PGM state`.

## 2.3 Responses are XHTML with the data in `class` attributes

RWS 2.0 answers with XHTML documents where values sit inside `<span class="ctrlstate">motoron</span>`.
Hence the entire parser is one regex, `parseXhtml` (`:8`):

```js
var m = body.match(new RegExp('class="' + cls + '">([^<]*)<'));
return m ? m[1].trim() : null;
```

Regex over XML is deliberate — RWS output is machine-generated and flat, and this keeps the package
dependency-free. Two details that are load-bearing:

- **`[^<]*` not `[^<]+`**: an empty element returns `''` (present but empty), while `null` means
  "class not present at all". Callers distinguish those.
- **Case is not uniform across fields.** `opmode` comes back UPPERCASE (`AUTO`) while `ctrlstate` and
  `ctrlexecstate` are lowercase (`motoron`, `running`). **Always compare case-insensitively.**

`gofa-pose.js:19` is the canonical read to copy from.

## 2.3a Collection GETs are paginated at 100, and the cap is not negotiable

`GET /rw/iosystem/signals` returns **at most 100 signals**, with the remainder behind
`<a href="signals?start=100&amp;limit=100" rel="next">`. The 100 is a hard controller-side cap, not a
default a larger request can raise — confirmed live 2026-08-05 that `?limit=500`, `?limit=1000` and
`?start=0&limit=300` each came back with exactly 100 items *and* a `next` link. Following the link
is the only way to see the whole collection.

This is the kind of bug that hides for a year and then looks like something else entirely. The
controller had 96 I/O signals — just under the cap — so page one *was* the whole list and every
node reading only page one was accidentally correct. Installing a Modbus TCP add-in added 161
signals (273 total), and because the collection is ordered with the Modbus device first, **all 32
`ABB_Scalable_*` signals moved to pages 2–3**. Every Known Signals dropdown in the palette quietly
lost the robot's own I/O while still looking populated — it was full of `mb_*` entries.

`lib/list-signals.js` now owns this: `fetchSignals(robot)` walks `rel="next"` to exhaustion and is
what all five listing nodes call (`gofa-io-list`, `gofa-di-read`, `gofa-do-write`, `gofa-grip`,
`gofa-subscribe-io`). It decodes `&amp;` in the href, stops if the controller ever echoes a link it
already followed, caps at 100 pages, and on a mid-walk failure returns the pages already gathered
rather than throwing away a partial list. The bare `parseSignalList` export is still there for
parsing a single response body.

**Assume every RWS collection paginates.** Only `/rw/iosystem/signals` has been audited; if you add
a node that lists `/rw/rapid/tasks`, `/rw/elog/<domain>` or any other collection, check for a `next`
link before trusting the first response to be complete. Point reads (`/rw/iosystem/signals/<name>`)
are unaffected — a bare signal name resolves regardless of which page it sits on, and regardless of
its network/device path (`mb_do72` and `Virtual/MB_Device/mb_do72` both work).

## 2.4 Mastership

RAPID variable writes, `resetpp`, `loadmod` and `activate` are ownership-locked. `withMastership(fn)`
(`:336`) wraps a call in `POST /rw/mastership/edit/request` … `POST /rw/mastership/edit/release`.

**The release runs on both the success and the failure path** (`:341`–`:351`), and the failure path
rethrows the original error even if the release itself fails. Leaking the lock keeps the FlexPendant
out of editing until timeout, so never hand-roll this — use the helper, or `mastership-test.js` for
ad-hoc probing.

Note the comment at `:334`: **edit is the only domain OmniCore lets you request explicitly.** General
and motion mastership are held internally by the RAPID runtime and cannot be taken.

## 2.5 fileservice — the controller as a fileserver

GET/PUT/DELETE under `/fileservice/<path>` reach the controller's own disk. **Every such URL must go
through `escapeFileservicePath` (`:88`)**: per-segment `encodeURIComponent` so `/` stays a separator,
then `%24` → `$` so `$HOME` stays literal.

This is not cosmetic. **Node's HTTP client throws client-side** on an unescaped space
(`Request path contains unescaped characters`) — the request never leaves the host. The controller
itself accepts `%20` and stores a real space.

The points system is built entirely on this (`:665`–`:697`): GET the JSON file, mutate the array in
memory, PUT the whole file back. Full overwrite, no append, no locking. `warnIfRemoteChanged` (`:689`)
re-reads before writing and warns on drift — it narrows the race, it does not close it. Format details
are in [`points-system.md`](points-system.md).

## 2.6 WebSocket subscriptions

Real controller-initiated push, shared by the three WS `gofa-subscribe-*` nodes via
`nodes/lib/rws-subscription.js`. Three steps:

1. **`POST /subscription`** with a form body enumerating resources (`:42`):
   `resources=1&1=<url-encoded resource path>&1-p=<priority>`. The `;state` suffix on a resource path
   selects which aspect to watch. Expect **HTTP 201** with `Location: wss://…/poll/<pollkey>`.
2. **Upgrade to WS on that Location** with subprotocol `rws_subscription` and the session cookie
   (`:67`). `nodes/lib/ws.js` is a from-scratch RFC 6455 client — handshake plus manual frame parsing
   including fragmentation — written so the package keeps **zero runtime dependencies**.
3. **Frames arrive as XHTML fragments**, parsed with the same `class="…"` regex trick
   (`gofa-subscribe-io.js:6`).

**Four concurrency traps, each learned live and each now encoded in one shared place:**

- **Subscription creation is serialized across all nodes sharing a session** —
  `queueSubscription()` (`gofa-robot.js:263`). Two `POST /subscription` within milliseconds of each
  other (the normal case for auto-injects at deploy) returned a real **HTTP 500**.
- **The WS upgrade must use the cookie from *that* subscribe response**, captured synchronously in
  the same response callback (`:393`), not a later `getCookie()`. The shared cookie can be overwritten
  by another node's concurrent response in between, and the upgrade then authenticates as the wrong
  session.
- **Drop the held subscription *before* re-subscribing** (`rws-subscription.js:48`,
  `nodes/lib/drop-subscription.js`). The reconnect path arrives with `_pollkey` still set from the
  dead connection; overwriting it orphans a subscription on the controller with nothing left holding
  its key. They accumulate against the 19-session cap.
- **A node closed while the subscribe POST is still in flight must delete the subscription itself**
  (`:57`–`:61`) — `close()` ran when `_pollkey` was still `null`.

**Not everything can be subscribed.** `gofa-subscribe-io` treats an HTTP 400 on subscribe as "this
controller will not watch this resource" and degrades to 500 ms polling with change-detection
(`gofa-subscribe-io.js:80`, `:32`). `gofa-subscribe-var` and `gofa-subscribe-pose` are *always*
polling — RWS exposes no subscribable resource for them.

---

# 3. The node layer over both transports

Every worker node is the same shape; `gofa-ping.js` is the minimal readable example.

**The config node owns all connection state.** `gofa-robot` holds one `createRobotClient` closure —
cookie, login promise, subscription queue, per-port ping versions — shared by every node pointing at
it. Worker nodes are stateless and just call `node.robot.rwsGet(...)` / `socketSend(...)`.

**`msg.payload` is always `{ ok: boolean, … }`**, never a bare value, and **both** the success and
error branches `send(msg)` so a flow can route on `ok` instead of relying on catch nodes.

**`nodes/lib/gate.js` wraps `send`.** Default is OFF: the node emits a bare `{_msgid}` to continue the
flow, and only passes the full payload when "Output payload" is ticked. Wrap once at the top of the
handler (`send = gate(config, send)`), including in nodes that emit outside `input` — see
`gofa-subscribe-io.js:18`, which rebinds `node.send` itself.

**Two entry paths, one implementation.** Every node registers `RED.httpAdmin` routes for its editor
panel buttons, which run with **no deployed flow involved** (`interactive-panels.md`). The runtime
handler and the admin route must call the same shared function — `gofa-jog.js:23` and `:53` both go
through `lib/jog.js`. Duplicating the logic across the two paths is the specific mistake that
produced two of the bugs found in the 2026-08-04 audit; `gofa-setup`, `gofa-connection-status`,
`gofa-rapid-exec`, `gofa-file`, `gofa-sequencer`, `gofa-points` and `gofa-jog` all follow the shared
form now.

**State-changing admin routes must use `requireAdminAuth`, not `RED.auth.needsPermission`.**
`needsPermission` is a **no-op when Node-RED has no `adminAuth`**, so on a default install anyone who
can reach the admin port could curl a motion endpoint — the browser `confirm()` dialogs are
client-side only. `nodes/lib/require-admin-auth.js` returns 403 in that configuration unless the
`gofa-robot` config node has "Allow insecure live control" ticked. Read routes may keep plain
`needsPermission`.

---

## Where to look next

- Command surface and manual driving: [`MANUAL_CONTROL.md`](../MANUAL_CONTROL.md)
- Per-command behaviour, gotchas, bugfix history: [`rapid-protocol-notes.md`](rapid-protocol-notes.md)
- Version handshake and the socket-wedge watchdog: [`version-handshake-watchdog.md`](version-handshake-watchdog.md)
- Editor-panel routes and their auth: [`interactive-panels.md`](interactive-panels.md)
- EGM's separate UDP path: [`egm.md`](egm.md)

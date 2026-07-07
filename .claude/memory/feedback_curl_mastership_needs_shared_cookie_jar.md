---
name: feedback-curl-mastership-needs-shared-cookie-jar
description: "Use mastership-test.js / the /mastership-test skill for mastership-gated RWS tests instead of hand-rolled curl; it removes the shared-cookie-jar failure mode entirely"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 58ab807b-429c-4693-a7f1-105ef986edca
---

When live-testing an RWS action that needs mastership (edit or motion domain), **use the `/mastership-test` skill (`node-red-contrib-abb-gofa/mastership-test.js`)**, not hand-rolled `curl`. It wraps the call in `createRobotClient()`'s `withMastership()` — one shared session, request → call → release, release guaranteed even on failure — so the failure mode below can't happen. Usage: `MSYS_NO_PATHCONV=1 node mastership-test.js <path> [body] [--hal]` (add `--hal` for endpoints like `loadmod`/`activate` that need `Accept: application/hal+json;v=2.0`).

**Why this tool exists:** hit the underlying bug live on 2026-07-06 testing RWS `loadmod` on the GoFa controller (192.168.20.36) — three separate curl calls (request/loadmod/release) each without a shared cookie jar left edit mastership stuck held by a dead session (`uid 1049618801`, application `RobAPI2-Client`), confirmed via `GET /rw/mastership/edit` showing `mastershipheldbyme: FALSE` for a session that no longer existed. No documented way to force-release someone else's hold; it only clears via RWS's 5-minute inactivity timeout (see [[project-robot-live-test-log]] for the resolution). A later session (2026-07-06, different `originSessionId`) also hit the sibling mistake — a bare `curl -X POST` with no `Content-Type` header on the empty-body mastership request/release gets `406 Content type is not supported` — and built `mastership-test.js` specifically so nobody has to remember either gotcha by hand again.

**How to apply:** default to `/mastership-test` for any mastership/write-access-gated RWS endpoint (edit mastership, resetpp, loadmod, activate, RAPID var writes, RW8 control-station write access, etc.) — not just when explicitly asked. Only fall back to raw `curl` if the tool itself can't express the test (e.g. a GET-based or non-standard-header case it doesn't support yet) — and even then, still use one shared cookie jar (`-c jar -b jar`) across the whole request/action/release sequence, never three independent bare-auth calls.

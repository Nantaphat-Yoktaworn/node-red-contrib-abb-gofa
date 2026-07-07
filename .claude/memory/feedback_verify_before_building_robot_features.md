---
name: verify-before-building-robot-features
description: "Curl/socket-test a robot command against the live controller before writing node code, and re-test the built node against the real robot afterward"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 85150159-a241-4082-b227-b1453acc1c07
---

When implementing or changing anything that talks to the ABB GoFa robot (a new RWS endpoint, a new RAPID socket command, or a fix to how an existing one is called): test the raw command against the live controller **first**, only build if that succeeds, then test the finished node against the live controller **again**.

Concretely:
1. Curl the RWS endpoint (or send the raw socket command, e.g. a PowerShell `TcpClient` one-off) against the live controller before writing any node code.
2. Only proceed to build if the live test confirms the endpoint/command exists and behaves as expected. If it fails, a few well-motivated path variants are reasonable, but don't guess indefinitely — report the negative result instead.
3. After building, re-test the actual node module (not just mocked unit tests) against the real robot before calling the work done.

**Why:** Documented/remembered API shapes aren't reliable for this specific controller — e.g. RWS's documented `/rw/rapid/symbol/data/...` endpoint 404s here because OmniCore (RWS 2.0) restructured it into a search-based `/rw/rapid/symbols` (plural) resource, not because of any missing license. Mocked unit tests only prove code matches assumptions, not that those assumptions about RWS/RAPID behavior are correct. This exact process (curl → build → re-verify live) caught the `gofa-rapid-exec` motors-off false-success bug and avoided building a generic RWS variable-write node on a dead endpoint.

**Correction (same session):** the first version of this note claimed that 404 was because of a missing "PC Interface" RobotWare option — copied from an old, never-verified code comment and stated as fact without checking. It was wrong: verified against ABB's own OmniCore product manual that RWS is a standard included feature, and that the real OmniCore option in this space (RobotStudio Connect [3119-1]) is about the RobotStudio *desktop app* connecting over WAN, unrelated to the REST API. The user caught this by asking "is that really the reason, or do you say that reflexively?" — a fair challenge. **Extend the rule:** verifying that an endpoint fails isn't the same as verifying *why* it fails. Before writing a root-cause explanation into docs, back it with an actual source (official manual, the controller's own error/response detail, a confirmed working example) — not a plausible-sounding guess, and not an old comment someone else never verified either.

**How to apply:** Applies to `node-red-contrib-abb-gofa` work specifically — any new/changed node that calls RWS or the RAPID TCP socket server. Also codified in the `abb-rws` skill (`.claude/commands/abb-rws.md`, "Development workflow" section at the top) so it's visible in-repo, not just in memory. See [[project-abb-gofa-hardware-access]] if that memory exists — this project has a real, network-reachable robot controller, so live verification is actually possible, not hypothetical.

**Second correction (2026-07-06, different session):** a later session curl-tested `loadmod` (RWS action to reload a RAPID module), got `405` on the documented query-action form, and nearly wrote "confirmed impossible" into `CLAUDE.md`/the `abb-rws` skill after trying only 2-3 path/name variants — before re-reading [[project-robot-live-test-log]] in full and finding an *earlier* session had already found the correct path-based form + a non-default `Accept: application/hal+json;v2.0` header, confirmed working. **Extend the rule again:** before declaring a "confirmed impossible" verdict (a strong, durable claim other sessions will trust without re-testing), first read the full live-test-log memory for that exact endpoint — not just its title/summary — since a prior session may have already found the working shape after the same initial-attempt failure. A `405`/`404` on the *first* request shape tried is evidence that shape is wrong, not that the capability doesn't exist.

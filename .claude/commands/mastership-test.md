# Mastership-gated RWS test

Run the standalone mastership-test script to live-test an RWS endpoint that
requires edit mastership (`resetpp`, `loadmod`, `unloadmod`, `activate`, a
RAPID var write, or any newly-discovered mastership-gated action), instead of
hand-rolling separate `curl` calls for request/action/release.

1. Check robot status first — see `/robot-status`. Don't run a mastership test
   blind against an unknown robot state.
2. Run from `node-red-contrib-abb-gofa/` via Bash:
   ```
   MSYS_NO_PATHCONV=1 node mastership-test.js <path> [body] [--hal]
   ```
   - `<path>` — the RWS resource path, e.g. `/rw/rapid/execution/resetpp`.
   - `[body]` — url-encoded form body, e.g.
     `'modulepath=$HOME/Programs/MainModule.mod&replace=true'`.
   - `--hal` — send `Accept: application/hal+json;v=2.0` instead of this
     project's usual `xhtml+xml` (needed for `loadmod`/`activate`; see
     CLAUDE.md's "Module reload (`loadmod`) note").
   - `MSYS_NO_PATHCONV=1` is required in Git Bash or the leading `/` in
     `<path>` gets rewritten into a Windows path before Node sees it.
   - Same `GOFA_IP`/`GOFA_RWS_PORT`/`GOFA_SOCKET_PORT`/`GOFA_USERNAME`/
     `GOFA_PASSWORD` env var overrides as `check-status.js`.
3. The script always acquires mastership, calls the endpoint, and releases
   mastership — even on failure — in one shared session. **Never** test a
   mastership-gated endpoint with separate bare-auth `curl` calls for
   request/action/release; that's what orphaned a lock for ~5 minutes in an
   earlier session (see the `feedback-curl-mastership-needs-shared-cookie-jar`
   memory).
4. Report the result concisely: the endpoint tested, success/failure, and the
   response body if it's informative (e.g. `loadmod`'s reported module name).

Use this any time a task looks like "try/verify a new or existing
mastership-gated RWS action live" — not just when explicitly asked to use it.

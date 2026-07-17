# Robot status check

Run the standalone status-check script against the live GoFa controller and
report the result to the user concisely.

1. Run `node check-status.js` from `node-red-contrib-abb-gofa/` via Bash.
   - If the user asked for more detail (RobotWare version, controller
     identity, RAPID task state, recent errors), add `--full`.
   - `--json` for machine-readable output; `--discover` to scan the LAN for
     controllers instead of checking a single configured IP.
   - Exit codes: `0` OK, `1` RWS unreachable, `2` RWS OK but socket unreachable.
   - Connection defaults (IP, ports, credentials) are baked into the script
     matching CLAUDE.md's documented values; override via `GOFA_IP`,
     `GOFA_RWS_PORT`, `GOFA_SOCKET_PORT`, `GOFA_USERNAME`, `GOFA_PASSWORD`
     env vars if the robot's address has drifted (it has before).
2. Summarize the output for the user: Motors (on/off), Mode (Auto/Manual),
   RAPID (running/stopped), Speed override, and socket reachability. Flag
   anything that looks like it would block a live test (motors off, socket
   unreachable, RAPID already running when it shouldn't be, etc.).
3. This is exactly the preflight check documented in CLAUDE.md/memory as
   mandatory before any live RWS/socket test against the robot — use it
   before running other live tests, not just when explicitly asked for status.

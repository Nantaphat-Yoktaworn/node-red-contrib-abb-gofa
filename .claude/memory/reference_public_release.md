---
name: reference-public-release
description: "Package is PUBLIC as of 2026-07-08 — npm + flow library URLs, release process, what that implies for future changes"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 3c34e333-1014-4b1f-99aa-7f1bac86972b
---

`node-red-contrib-abb-gofa` went public 2026-07-08 (`1.0.1`):
- npm: https://www.npmjs.com/package/node-red-contrib-abb-gofa (account `nnnn022`, 2FA enabled —
  publish opens a browser auth prompt, not an OTP code entry; Claude Code cannot complete this
  step, the user must run `npm publish` themselves)
- Flow library: https://flows.nodered.org/node/node-red-contrib-abb-gofa
- GitHub repo is public; CI (GitHub Actions `npm install` + `npm test`) green on main.

**Release history**: `1.0.1` (2026-07-08, initial public release) → `1.0.2` (2026-07-08, bundled
example flows for the flow-library scorecard) → `1.1.0` (2026-07-09, `gofa-egm` node + EGM
support — see [[project_egm_node_red_integration_plan]]; minor bump since it's a new backward-
compatible feature, not a patch).

Implications for all future work:
- Repo is public — never write real credentials into tracked files (see [[user-robot-credentials]]).
- Release process for any palette change: bump version (`npm version patch` in the package dir),
  `npm publish` (interactive — 2FA/OTP, user must run it), flow library re-indexes automatically.
- The npm tarball ships only `nodes/`, `rapid/`, README, LICENSE (`files` allowlist);
  `prepack` re-copies `rapid/MainModule.mod` from the repo root's `rapid/` on every pack —
  edit the repo-root copy, not the package copy.
- The package README (node-red-contrib-abb-gofa/README.md) is the public npm/flow-library
  landing page and must stand alone — no relative links to repo-root files.

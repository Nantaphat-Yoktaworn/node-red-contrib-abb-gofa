---
name: project-ip-discovery-deferred
description: "check-status.js auto-discovering the robot's IP when it drifts — design sketched, explicitly deferred, not built"
metadata: 
  node_type: memory
  type: project
  originSessionId: a2de9698-6f0f-4965-89e8-d946e2e775fa
---

The user asked whether `check-status.js` (see CLAUDE.md's "Standalone status-check script" section) could auto-find the GoFa controller's IP if it changes — it has drifted before (`192.168.20.33` documented default → `192.168.20.36` seen in live tests). Design was proposed and explicitly deferred, not rejected: when asked to confirm a local-subnet-scan approach, the user chose "let's save this idea for later" rather than approve or decline it.

**Design sketched (not implemented):** a fallback that only triggers when the configured/cached IP is unreachable — two-phase scan of the machine's own local /24 (or whatever CIDR its own interface reports): phase 1 is a cheap TCP-connect-only probe across the subnet on ports 443 and 1025 to narrow candidates fast; phase 2 confirms each narrowed candidate is actually the GoFa by a real RWS Basic-auth GET and/or a socket `PING` → `OK:PING` (the same credentials/protocol the tool already uses — not a new auth mechanism). Would cache the last confirmed-good IP in a small file outside git (e.g. repo-root `.gofa-cache.json`, naturally ignored since the repo's `.gitignore` only allowlists specific paths). Proposed flags: `--discover` (force a rescan) / `--no-discover` (disable the fallback for fast/CI-style checks).

**Why this exists as a memory and not just closed code:** so a future session asked to build this doesn't have to re-derive the design from scratch or re-propose the same subnet-scan approach and get the same "save for later" answer again — the design is sound and already vetted, it's just not something the user wanted built in that moment.

**How to apply:** if asked again to make any GoFa tool recover from an IP change, start from this design rather than reinventing it — but confirm the user actually wants it built *now* first, since this was deferred, not approved. Don't assume deferred == wanted.

---
name: reference-manual-control-doc
description: "MANUAL_CONTROL.md has every curl/raw-TCP command to control the robot without Node-RED, split by RWS-always-works vs socket-needs-RAPID-running"
metadata: 
  node_type: memory
  type: reference
  originSessionId: b4719ce1-be0f-4548-af10-7dc9ee7c4e4f
---

`MANUAL_CONTROL.md` (repo root) is the curl/raw-TCP command reference for controlling the GoFa robot directly, without Node-RED — built 2026-07-06 by extracting the exact endpoint/body pairs straight from the palette's own node source (`node-red-contrib-abb-gofa/nodes/*.js`), not re-derived from memory.

Structure: Part A = RWS (HTTPS) commands, split into read-only / write-no-mastership / write-needs-mastership (`resetpp`/`loadmod`/`activate`, the latter two also require RAPID stopped); Part B = TCP socket commands (port 1025), which only work while RAPID is actually running `MainModule.mod`'s `main()` loop.

**How to apply:** if the user asks for a raw command to do something the palette already has a node for, check this file first before re-deriving the curl syntax from source — it's already verified (read-only RWS endpoints smoke-tested live, socket table and mastership constraints pulled from already-confirmed findings in [[project-robot-live-test-log]]). If a new node/endpoint is added later, update this file to match — it will drift otherwise.

---
name: project-gofa-egm-python
description: "Standalone Python EGM (Externally Guided Motion) project for the GoFa robot, separate from the node-red-contrib-abb-gofa palette"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9eca4288-c5b3-4c60-8ab2-b3689a8167e6
---

Built `C:\Users\anapa\nnnn\gofa-egm-python` (2026-07-08) as a standalone learning
project to control the GoFa arm via ABB's EGM (Externally Guided Motion) — a
UDP/protobuf real-time streaming protocol, fundamentally different from the
request/reply RAPID socket server in the node-red-contrib-abb-gofa palette's
MainModule.mod. EGM option 3124-1 is confirmed licensed on this controller
(see the omnicore-c30 skill).

**Why:** [[user_learning_context]] — exploring EGM as a "learn everything"
broadening exercise, no specific business need yet. EGM is the only channel
on this hardware capable of sub-10ms closed-loop control (RWS subscribe/poll
tops out around 500ms).

**Status: proven working end-to-end** — confirmed live with real, visible
joint motion (joint 5, +/-3 degree sine sweep, returns cleanly to baseline).

**Structure:**
- `proto/egm.proto` — ABB's real wire schema, pulled verbatim from
  `ros-industrial/abb_libegm` (BSD-3, redistributes ABB's own schema)
- `egm_pb2.py` — compiled via grpcio-tools; regenerate with
  `.venv/Scripts/python.exe -m grpc_tools.protoc -I proto --python_out=. proto/egm.proto`
- `egm_client.py` — UDP+protobuf core; has a self-test (no network) proving
  encode/decode round-trips
- `stream_watch.py` — passive listener, echoes the controller's own planned
  position back (safe, no motion)
- `nudge_joint.py` — bounded real-motion demo, sine sweep on one joint
  (`--joint 1-6`, `--amplitude-deg`, `--seconds`)
- `rapid/EGMJointModule.mod` — RAPID side, adapted from ATONATON's
  `abb_egm_hello_world` reference, trimmed to 6 axes
- `reload_module.js` — reuses node-red-contrib-abb-gofa's `createRobotClient()`
  (relative `require` into the sibling repo's `nodes/gofa-robot.js`) to script
  stop -> upload -> loadmod -> resetpp -> start, instead of reimplementing RWS
  auth/mastership handling. Run this after any edit to `EGMJointModule.mod`.

**Key gotcha found the hard way:** `egm_minmax` (the `\J1..\J6` args to
`EGMActJoint`) is NOT a tracking tolerance — it's a hard position-correction
clamp in degrees. The reference module used +/-0.001, which silently clamped
every commanded offset to nothing: the whole UDP/protobuf pipe worked
perfectly (feedback flowed, replies were accepted, no errors anywhere) but
the robot never visibly moved. No error, no warning, just silence. Fixed by
widening to +/-10.0. Before writing more EGM RAPID code, always check this
window is bigger than whatever amplitude will actually be commanded.

**Also needed:** a scoped Windows Firewall inbound rule for UDP port 6510
from the robot's subnet (`192.168.20.0/24`) — this dev machine's Wi-Fi
network is classified "Public" by Windows, and a fresh Python install has no
inbound allowance by default, so controller packets were silently dropped
with no error on either side until the rule was added.

**One-time controller-side config required** (not automatable from here): a
UDPUC Transmission Protocol named `EGM_PC` in RobotStudio's Configuration
Editor (Remote Address = dev PC's IP on the robot's subnet, Remote Port
6510, Local Port 0), requiring a controller restart to take effect.

**Architectural constraint:** `EGMRunJoint` blocks the RAPID task for the
session duration, so `EGMJointModule.mod` and `MainModule.mod`'s socket
server can't run in the same task at once — swap between them for now.
Multitasking (3114-1) is licensed on this controller but not wired up to run
both concurrently in separate tasks.

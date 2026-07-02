# node-red-contrib-abb-gofa

Node-RED nodes for controlling an **ABB GoFa CRB 15000** collaborative robot (OmniCore C30 controller) over the local network. No extra ABB licenses required.

Full setup guide (RAPID upload, RWS user permissions, wiring a flow) lives in the [repo-root README](../README.md). This file just covers installing and using the palette itself.

## Requirements

- ABB GoFa CRB 15000 with OmniCore C30, RobotWare 7.x
- `rapid/MainModule.mod` (in the parent repo) uploaded and running on the controller — motion commands go over its TCP socket server on port 1025
- Node-RED v3+, Node.js v18+

## Install

From your Node-RED user directory (usually `~/.node-red`):

```bash
npm install /path/to/node-red-contrib-abb-gofa
```

Then restart Node-RED. A `gofa-robot` config node and 41 `gofa-*` nodes appear under a "GoFa" category in the palette.

## Usage

1. Add a `gofa-robot` config node — set the robot IP, RWS/socket ports, username, and password (see the repo-root README for creating an RWS user with the right grants).
2. Wire up any `gofa-*` node and point it at that config node.
3. See `flows/gofa_demo_flow.json` and `flows/robot_palette_flow.json` in the parent repo for ready-made flows covering every node.

Two transports are used under the hood: motion commands go through the RAPID TCP socket (port 1025), everything else (telemetry, motor on/off, I/O, file transfer) goes through RWS over HTTPS (port 443). See the repo-root README for the full node reference and RAPID socket protocol.

## Test

```bash
npm test
```

Runs `test.js` — unit tests for the pure helpers (`gotoToken`, `parseXhtml`, points persistence, LED payload resolution) plus integration-style tests that drive node `input` handlers against a minimal Node-RED harness (points import/export, sequencer, stop-seq).

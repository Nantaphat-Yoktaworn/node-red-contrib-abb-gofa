// Runs on npm pack/publish: re-sync bundled files from the repo root so the
// package can't drift from the source of truth.
'use strict';
const fs = require('fs');

fs.cpSync('../rapid/MainModule.mod', 'rapid/MainModule.mod');
fs.cpSync('../rapid/MainModuleEGM.mod', 'rapid/MainModuleEGM.mod');
fs.cpSync('../rapid/BackgroundLed.mod', 'rapid/BackgroundLed.mod');

// Example flows = repo flows with this lab's username/IP genericized.
// "*_th.json" files are local-only, gitignored, Thai-annotated learning copies —
// never ship them to npm, regardless of whether they happen to exist in flows/
// on the machine running this script (fs.readdirSync doesn't know about .gitignore).
fs.mkdirSync('examples', { recursive: true });
for (const f of fs.readdirSync('../flows').filter(f => f.endsWith('.json') && !f.endsWith('_th.json'))) {
    const text = fs.readFileSync('../flows/' + f, 'utf8')
        // Match the "username" field itself, not one hardcoded value — this lab's
        // controller account has already changed once (NNNN -> Admin, 2026-07-22),
        // and a value-specific regex silently stops genericizing the moment it
        // changes again, leaking this lab's real current username into the public
        // package (exactly what happened here: this line only ever matched "NNNN",
        // so it silently passed the real "Admin" straight through unchanged).
        .replace(/"username":\s*"[^"]*"/g, '"username": "Default User"')
        // Match the "ip" field itself, not one hardcoded subnet — this lab's robot
        // has drifted across several subnets already (192.168.20.x, 192.168.1.x),
        // and a subnet-specific regex silently stops genericizing the moment it
        // drifts again, leaking this lab's real current IP into the public package.
        // Genericized to ABB's neutral service-port default (matches gofa-robot's
        // own config default), not any address this lab has actually used.
        .replace(/"ip":\s*"[^"]*"/g, '"ip": "192.168.125.1"')
        // Force the live-control escape hatch OFF in every published example.
        // This lab's own flows/ set it true (the cell is network-isolated, so the
        // guard in nodes/lib/require-admin-auth.js is redundant here) — but a
        // stranger importing an example onto a default Node-RED has no adminAuth,
        // and RED.auth.needsPermission() is a NO-OP in that state. Shipping true
        // would leave all 22 requireAdminAuth-gated endpoints — jog, movej, motor
        // on, sequencer start — reachable unauthenticated by anyone who can hit
        // the admin port. Matches the field, not one hardcoded value, for the same
        // reason as the ip/username rules above.
        .replace(/"allowInsecureLiveControl":\s*(?:true|false)/g, '"allowInsecureLiveControl": false');
    fs.writeFileSync('examples/' + f, text);
}
console.log('prepack: synced rapid/*.mod and examples/ from repo root');

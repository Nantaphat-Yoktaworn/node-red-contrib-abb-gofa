// Runs on npm pack/publish: re-sync bundled files from the repo root so the
// package can't drift from the source of truth.
'use strict';
const fs = require('fs');

fs.cpSync('../rapid/MainModule.mod', 'rapid/MainModule.mod');
fs.cpSync('../rapid/MainModuleEGM.mod', 'rapid/MainModuleEGM.mod');
fs.cpSync('../rapid/BackgroundLed.mod', 'rapid/BackgroundLed.mod');

// Example flows = repo flows with this lab's username/IP genericized
fs.mkdirSync('examples', { recursive: true });
for (const f of fs.readdirSync('../flows').filter(f => f.endsWith('.json'))) {
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
        .replace(/"ip":\s*"[^"]*"/g, '"ip": "192.168.125.1"');
    fs.writeFileSync('examples/' + f, text);
}
console.log('prepack: synced rapid/*.mod and examples/ from repo root');

// Runs on npm pack/publish: re-sync bundled files from the repo root so the
// package can't drift from the source of truth.
'use strict';
const fs = require('fs');

fs.cpSync('../rapid/MainModule.mod', 'rapid/MainModule.mod');
fs.cpSync('../rapid/MainModuleEGM.mod', 'rapid/MainModuleEGM.mod');

// Example flows = repo flows with this lab's username/IP genericized
fs.mkdirSync('examples', { recursive: true });
for (const f of fs.readdirSync('../flows').filter(f => f.endsWith('.json'))) {
    const text = fs.readFileSync('../flows/' + f, 'utf8')
        .replace(/"username": "NNNN"/g, '"username": "Default User"')
        // Match the "ip" field itself, not one hardcoded subnet — this lab's robot
        // has drifted across several subnets already (192.168.20.x, 192.168.1.x),
        // and a subnet-specific regex silently stops genericizing the moment it
        // drifts again, leaking this lab's real current IP into the public package.
        .replace(/"ip":\s*"[^"]*"/g, '"ip": "192.168.20.33"');
    fs.writeFileSync('examples/' + f, text);
}
console.log('prepack: synced rapid/*.mod and examples/ from repo root');

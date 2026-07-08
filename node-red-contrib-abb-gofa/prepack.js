// Runs on npm pack/publish: re-sync bundled files from the repo root so the
// package can't drift from the source of truth.
'use strict';
const fs = require('fs');

fs.cpSync('../rapid/MainModule.mod', 'rapid/MainModule.mod');

// Example flows = repo flows with this lab's username/IP genericized
fs.mkdirSync('examples', { recursive: true });
for (const f of fs.readdirSync('../flows').filter(f => f.endsWith('.json'))) {
    const text = fs.readFileSync('../flows/' + f, 'utf8')
        .replace(/"username": "NNNN"/g, '"username": "Default User"')
        .replace(/192\.168\.20\.\d+/g, '192.168.20.33');
    fs.writeFileSync('examples/' + f, text);
}
console.log('prepack: synced rapid/MainModule.mod and examples/ from repo root');

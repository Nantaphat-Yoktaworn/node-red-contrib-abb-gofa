const fs = require('fs');
let txt = fs.readFileSync('test.js', 'utf8');

// gofa-points-export -> gofa-points, export is default so no config change needed
// But we still need to fix the node instantiation if it changed. Actually we replaced strings.
// Let's just fix the node constructors properly.
txt = txt.replace(/loadNodeType\('\.\/nodes\/gofa-points', \{ nodesById: \{ r1: mockRobot \} \}\)\)\(\{ robot: 'r1' \}/g, "loadNodeType('./nodes/gofa-points', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'import' }"); // wait, this would replace ALL.

// Let's do a git checkout test.js first to revert my previous dumb script

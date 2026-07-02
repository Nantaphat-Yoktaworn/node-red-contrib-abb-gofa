'use strict';
var assert = require('assert');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var robot  = require('./nodes/gofa-robot');
var gotoToken           = robot.gotoToken;
var parseXhtml          = robot.parseXhtml;
var atomicWriteFileSync = robot.atomicWriteFileSync;
var fileMtimeMs         = robot.fileMtimeMs;
var resolveMoveType     = robot.resolveMoveType;
var patchServerIp       = require('./nodes/gofa-upload-mod').patchServerIp;

var passed = 0, failed = 0;
function check(label, fn) {
    try { fn(); console.log('PASS ' + label); passed++; }
    catch(e) { console.error('FAIL ' + label + ' — ' + e.message); failed++; }
}
function checkAsync(label, fn) {
    return Promise.resolve().then(fn).then(function() {
        console.log('PASS ' + label); passed++;
    }, function(e) {
        console.error('FAIL ' + label + ' — ' + e.message); failed++;
    });
}

// ── minimal Node-RED harness — enough to instantiate/drive a node module
// without pulling in the real Node-RED runtime ──────────────────────────────
function loadNodeType(modulePath, opts) {
    opts = opts || {};
    var Ctor;
    var fakeRED = {
        nodes: {
            createNode: function(node, config) {
                node.credentials = config.credentials || {};
                node._handlers = {};
                node.on     = function(evt, fn) { node._handlers[evt] = fn; return node; };
                node.warnings = []; node.errors = []; node.statuses = []; node.sent = [];
                node.warn   = function(m) { node.warnings.push(m); };
                node.error  = function(m) { node.errors.push(m); };
                node.status = function(s) { node.statuses.push(s); };
                node.send   = function(m) { node.sent.push(m); };
            },
            getNode:      function(id) { return (opts.nodesById || {})[id] || null; },
            registerType: function(type, C) { Ctor = C; }
        },
        settings: { userDir: opts.userDir || os.tmpdir() },
        util:     { cloneMessage: function(m) { return JSON.parse(JSON.stringify(m)); } },
        httpAdmin: { get: function() {} },
        auth:      { needsPermission: function() { return function() {}; } }
    };
    require(modulePath)(fakeRED);
    return Ctor;
}
// Drives a node's 'input' handler like the runtime would; resolves with
// whatever the node passed to done(err).
function runInput(node, msg) {
    return new Promise(function(resolve) {
        node._handlers['input'](msg, function(m) { node.sent.push(m); }, function(err) { resolve(err); });
    });
}

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gofa-test-'));

var sample = { x: 323.219, y: -81.812, z: 807.001,
               q1: 0.26714, q2: 0.12904, q3: 0.95361, q4: -0.05281,
               cf1: -1, cf4: -1, cf6: 0, cfx: 0 };

check('gotoToken: valid target produces GOTOJ string by default', function() {
    var tok = gotoToken(sample);
    assert.ok(tok.startsWith('GOTOJ'), 'should start with GOTOJ');
    assert.ok(tok.split(';').length === 11, 'should have 11 semicolon-separated values');
});

check('gotoToken: moveType "L" produces GOTOL string', function() {
    var tok = gotoToken(sample, 'L');
    assert.ok(tok.startsWith('GOTOL'), 'should start with GOTOL');
});

check('gotoToken: unrecognized moveType falls back to GOTOJ', function() {
    var tok = gotoToken(sample, 'bogus');
    assert.ok(tok.startsWith('GOTOJ'), 'should start with GOTOJ');
});

check('resolveMoveType: passes through "J" and "L"', function() {
    assert.strictEqual(resolveMoveType('J', 'L'), 'J');
    assert.strictEqual(resolveMoveType('L', 'J'), 'L');
});
check('resolveMoveType: falls back on anything else', function() {
    assert.strictEqual(resolveMoveType('bogus', 'J'), 'J');
    assert.strictEqual(resolveMoveType(undefined, 'J'), 'J');
    assert.strictEqual(resolveMoveType(null, 'L'), 'L');
});

check('gotoToken: xyz rounds to 1 decimal place', function() {
    var tok = gotoToken(sample);
    var parts = tok.slice(5).split(';');
    assert.strictEqual(parts[0], '323.2');
    assert.strictEqual(parts[1], '-81.8');
    assert.strictEqual(parts[2], '807.0');
});

check('gotoToken: quaternion rounds to 4 decimal places', function() {
    var tok = gotoToken(sample);
    var parts = tok.slice(5).split(';');
    assert.strictEqual(parts[3], '0.2671');
    assert.strictEqual(parts[4], '0.1290');
    assert.strictEqual(parts[5], '0.9536');
    assert.strictEqual(parts[6], '-0.0528');
});

check('gotoToken: config flags are integers', function() {
    var tok = gotoToken(sample);
    var parts = tok.slice(5).split(';');
    assert.strictEqual(parts[7],  '-1');
    assert.strictEqual(parts[8],  '-1');
    assert.strictEqual(parts[9],  '0');
    assert.strictEqual(parts[10], '0');
});

check('gotoToken: returns null when any value is NaN', function() {
    var bad = Object.assign({}, sample, { q1: NaN });
    assert.strictEqual(gotoToken(bad), null);
});

check('gotoToken: returns null when any value is Infinity', function() {
    var bad = Object.assign({}, sample, { z: Infinity });
    assert.strictEqual(gotoToken(bad), null);
});

check('parseXhtml: extracts value for matching class', function() {
    var body = '<span class="ctrlstate">motoron</span>';
    assert.strictEqual(parseXhtml(body, 'ctrlstate'), 'motoron');
});

check('parseXhtml: trims whitespace', function() {
    var body = '<span class="speedratio">  75  </span>';
    assert.strictEqual(parseXhtml(body, 'speedratio'), '75');
});

check('parseXhtml: returns null when class not found', function() {
    var body = '<span class="other">value</span>';
    assert.strictEqual(parseXhtml(body, 'ctrlstate'), null);
});

// ── gofa-robot: atomic points.json writes ───────────────────────────────────
check('atomicWriteFileSync: writes file with given contents', function() {
    var f = path.join(tmpDir, 'atomic-a.json');
    atomicWriteFileSync(f, '{"x":1}');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"x":1}');
});
check('atomicWriteFileSync: overwrites existing file cleanly', function() {
    var f = path.join(tmpDir, 'atomic-b.json');
    fs.writeFileSync(f, 'old');
    atomicWriteFileSync(f, 'new');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'new');
});
check('atomicWriteFileSync: leaves no leftover temp files', function() {
    var f = path.join(tmpDir, 'atomic-c.json');
    atomicWriteFileSync(f, 'data');
    var leftovers = fs.readdirSync(tmpDir).filter(function(n) { return n.indexOf('.tmp') >= 0; });
    assert.deepStrictEqual(leftovers, []);
});
check('fileMtimeMs: returns null for a missing file', function() {
    assert.strictEqual(fileMtimeMs(path.join(tmpDir, 'nope.json')), null);
});
check('fileMtimeMs: returns a number for an existing file', function() {
    var f = path.join(tmpDir, 'atomic-d.json');
    fs.writeFileSync(f, 'x');
    assert.strictEqual(typeof fileMtimeMs(f), 'number');
});

// ── gofa-robot: point management ────────────────────────────────────────────
function makeRobotNode(pointsFile) {
    var Ctor = loadNodeType('./nodes/gofa-robot');
    return new Ctor({ pointsFile: pointsFile });
}

check('gofa-robot: addPoint auto-names sequential points', function() {
    var node = makeRobotNode(path.join(tmpDir, 'points-1.json'));
    var p1 = node.addPoint('', { x: 1 });
    var p2 = node.addPoint('', { x: 2 });
    assert.strictEqual(p1.name, 'Point 1');
    assert.strictEqual(p2.name, 'Point 2');
});
check('gofa-robot: addPoint rejects duplicate names', function() {
    var node = makeRobotNode(path.join(tmpDir, 'points-2.json'));
    node.addPoint('pick1', { x: 1 });
    var res = node.addPoint('pick1', { x: 2 });
    assert.ok(res.error);
});
check('gofa-robot: addPoint persists to disk', function() {
    var f = path.join(tmpDir, 'points-3.json');
    var node = makeRobotNode(f);
    node.addPoint('pick1', { x: 1 });
    var onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(onDisk.length, 1);
    assert.strictEqual(onDisk[0].name, 'pick1');
});
check('gofa-robot: deletePoint removes by id and persists', function() {
    var f = path.join(tmpDir, 'points-4.json');
    var node = makeRobotNode(f);
    var p = node.addPoint('pick1', { x: 1 });
    node.deletePoint(p.id);
    assert.strictEqual(node.getPoints().length, 0);
    var onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(onDisk.length, 0);
});
check('gofa-robot: findPoint matches by name or id, else null', function() {
    var node = makeRobotNode(path.join(tmpDir, 'points-5.json'));
    var p = node.addPoint('pick1', { x: 1 });
    assert.strictEqual(node.findPoint('pick1'), p);
    assert.strictEqual(node.findPoint(p.id), p);
    assert.strictEqual(node.findPoint('missing'), null);
});
check('gofa-robot: _savePoints warns when the file changed on disk since last read', function() {
    var f = path.join(tmpDir, 'points-6.json');
    var node = makeRobotNode(f);
    node.addPoint('pick1', { x: 1 }); // first save creates the file, records its mtime
    var later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later); // simulate another process/config-node writing it
    node.warnings = [];
    node.addPoint('pick2', { x: 2 });
    assert.ok(node.warnings.some(function(w) { return w.indexOf('changed on disk') >= 0; }));
});

// ── gofa-upload-mod: SERVER_IP injection ────────────────────────────────────
var sampleMod = 'MODULE MainModule\n' +
                '    CONST string SERVER_IP   := "192.168.20.15";\n' +
                '    CONST num    SERVER_PORT := 1025;\n' +
                'ENDMODULE\n';

check('patchServerIp: replaces the quoted IP when the constant is present', function() {
    var res = patchServerIp(sampleMod, '10.0.0.5');
    assert.strictEqual(res.injected, true);
    assert.ok(res.text.indexOf('CONST string SERVER_IP   := "10.0.0.5";') >= 0);
});
check('patchServerIp: is case-insensitive on the CONST/SERVER_IP keywords', function() {
    var mod = 'const STRING server_ip := "1.2.3.4";';
    var res = patchServerIp(mod, '9.9.9.9');
    assert.strictEqual(res.injected, true);
    assert.ok(res.text.indexOf('"9.9.9.9"') >= 0);
});
check('patchServerIp: leaves the rest of the file untouched', function() {
    var res = patchServerIp(sampleMod, '10.0.0.5');
    assert.ok(res.text.indexOf('CONST num    SERVER_PORT := 1025;') >= 0);
    assert.ok(res.text.indexOf('MODULE MainModule') >= 0);
});
check('patchServerIp: no-ops when the constant is not present', function() {
    var mod = 'MODULE Other\nENDMODULE\n';
    var res = patchServerIp(mod, '10.0.0.5');
    assert.strictEqual(res.injected, false);
    assert.strictEqual(res.text, mod);
});

// ── gofa-asi-led ──────────────────────────────────────────────────────────────
var led = require('./nodes/gofa-asi-led');
var clamp          = led.clamp;
var PRESETS        = led.PRESETS;
var resolvePayload = led.resolvePayload;
var DEF = { r: 0, g: 0, b: 0, period: 0 };

// clamp
check('clamp: 128 stays 128', function() { assert.strictEqual(clamp(128), 128); });
check('clamp: -10 clamps to 0', function() { assert.strictEqual(clamp(-10), 0); });
check('clamp: 300 clamps to 255', function() { assert.strictEqual(clamp(300), 255); });
check('clamp: 1.7 rounds to 2', function() { assert.strictEqual(clamp(1.7), 2); });
check('clamp: NaN clamps to 0', function() { assert.strictEqual(clamp(NaN), 0); });

// PRESETS
check('PRESETS: off is all zeros', function() {
    assert.deepStrictEqual(PRESETS.off, { r: 0, g: 0, b: 0 });
});
check('PRESETS: red is R=255 only', function() {
    assert.deepStrictEqual(PRESETS.red, { r: 255, g: 0, b: 0 });
});
check('PRESETS: white is all 255', function() {
    assert.deepStrictEqual(PRESETS.white, { r: 255, g: 255, b: 255 });
});

// resolvePayload — null/undefined uses defaults
check('resolvePayload: null payload returns node defaults', function() {
    var d = { r: 10, g: 20, b: 30, period: 5 };
    var res = resolvePayload(d, null);
    assert.deepStrictEqual(res, { r: 10, g: 20, b: 30, period: 5 });
});

// resolvePayload — bare string preset
check('resolvePayload: "red" string sets red preset', function() {
    var res = resolvePayload(DEF, 'red');
    assert.deepStrictEqual(res, { r: 255, g: 0, b: 0, period: 0 });
});
check('resolvePayload: "RED" string is case-insensitive', function() {
    var res = resolvePayload(DEF, 'RED');
    assert.deepStrictEqual(res, { r: 255, g: 0, b: 0, period: 0 });
});
check('resolvePayload: unknown color string returns error', function() {
    var res = resolvePayload(DEF, 'purple');
    assert.ok(res.error, 'should have error property');
});

// resolvePayload — bare non-zero number (inject timestamp) uses defaults
check('resolvePayload: timestamp number uses node defaults', function() {
    var d = { r: 10, g: 20, b: 30, period: 5 };
    var res = resolvePayload(d, Date.now());
    assert.deepStrictEqual(res, { r: 10, g: 20, b: 30, period: 5 });
});

// resolvePayload — false / 0 turns off
check('resolvePayload: false turns off and resets period', function() {
    var res = resolvePayload({ r: 255, g: 255, b: 255, period: 10 }, false);
    assert.deepStrictEqual(res, { r: 0, g: 0, b: 0, period: 0 });
});
check('resolvePayload: 0 turns off', function() {
    var res = resolvePayload(DEF, 0);
    assert.deepStrictEqual(res, { r: 0, g: 0, b: 0, period: 0 });
});

// resolvePayload — object with color name
check('resolvePayload: { color: "green" } sets green preset', function() {
    var res = resolvePayload(DEF, { color: 'green' });
    assert.deepStrictEqual(res, { r: 0, g: 255, b: 0, period: 0 });
});
check('resolvePayload: { color: "green" } unknown returns error', function() {
    var res = resolvePayload(DEF, { color: 'rainbow' });
    assert.ok(res.error);
});

// resolvePayload — explicit r/g/b object
check('resolvePayload: { r, g, b } sets custom color', function() {
    var res = resolvePayload(DEF, { r: 100, g: 150, b: 200 });
    assert.deepStrictEqual(res, { r: 100, g: 150, b: 200, period: 0 });
});
check('resolvePayload: r/g/b values are clamped', function() {
    var res = resolvePayload(DEF, { r: 300, g: -5, b: 128 });
    assert.deepStrictEqual(res, { r: 255, g: 0, b: 128, period: 0 });
});

// resolvePayload — period
check('resolvePayload: { color, period } sets preset + blink period', function() {
    var res = resolvePayload(DEF, { color: 'blue', period: 50 });
    assert.deepStrictEqual(res, { r: 0, g: 0, b: 255, period: 50 });
});
check('resolvePayload: period is floored to integer', function() {
    var res = resolvePayload(DEF, { r: 0, g: 0, b: 0, period: 33.9 });
    assert.strictEqual(res.period, 34);
});
check('resolvePayload: negative period clamps to 0', function() {
    var res = resolvePayload(DEF, { r: 0, g: 0, b: 0, period: -10 });
    assert.strictEqual(res.period, 0);
});

// resolvePayload — r/g/b override after preset
check('resolvePayload: color preset + r override blends correctly', function() {
    var res = resolvePayload(DEF, { color: 'red', g: 128 });
    assert.deepStrictEqual(res, { r: 255, g: 128, b: 0, period: 0 });
});

// ── async node tests (drive the real 'input' handlers) ──────────────────────
(async function() {

// gofa-points-import ─────────────────────────────────────────────────────────
await checkAsync('gofa-points-import: array payload replaces points', async function() {
    var mockRobot = { _points: [{ id: 'old', name: 'old' }], _savePoints: function() { this._saved = true; } };
    var node = new (loadNodeType('./nodes/gofa-points-import', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: [{ id: 'p1', name: 'p1', target: {} }] };
    await runInput(node, msg);
    assert.strictEqual(mockRobot._points.length, 1);
    assert.strictEqual(mockRobot._points[0].name, 'p1');
    assert.ok(mockRobot._saved);
    assert.deepStrictEqual(msg.payload, { ok: true, count: 1, loadedFrom: null });
});
await checkAsync('gofa-points-import: {points:[...]} wrapper is unwrapped', async function() {
    var mockRobot = { _points: [], _savePoints: function() {} };
    var node = new (loadNodeType('./nodes/gofa-points-import', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    await runInput(node, { payload: { points: [{ id: 'p1', name: 'p1' }] } });
    assert.strictEqual(mockRobot._points.length, 1);
});
await checkAsync('gofa-points-import: loads from a file path in msg.payload', async function() {
    var f = path.join(tmpDir, 'import-1.json');
    fs.writeFileSync(f, JSON.stringify([{ id: 'p1', name: 'p1' }]));
    var mockRobot = { _points: [], _savePoints: function() {} };
    var node = new (loadNodeType('./nodes/gofa-points-import', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: f };
    await runInput(node, msg);
    assert.strictEqual(mockRobot._points.length, 1);
    assert.strictEqual(msg.payload.loadedFrom, f);
});
await checkAsync('gofa-points-import: missing file reports an error', async function() {
    var mockRobot = { _points: [], _savePoints: function() {} };
    var node = new (loadNodeType('./nodes/gofa-points-import', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var err = await runInput(node, { payload: path.join(tmpDir, 'missing.json') });
    assert.ok(err);
    assert.ok(node.errors.length > 0);
});
await checkAsync('gofa-points-import: missing robot config reports an error', async function() {
    var node = new (loadNodeType('./nodes/gofa-points-import', { nodesById: {} }))({ robot: 'nope' });
    await runInput(node, { payload: [] });
    assert.ok(node.errors.length > 0);
});

// gofa-points-export ─────────────────────────────────────────────────────────
await checkAsync('gofa-points-export: no savePath just outputs the points', async function() {
    var mockRobot = { getPoints: function() { return [{ id: 'p1', name: 'p1' }]; } };
    var node = new (loadNodeType('./nodes/gofa-points-export', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: null };
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload.points, [{ id: 'p1', name: 'p1' }]);
    assert.strictEqual(msg.payload.savedTo, undefined);
});
await checkAsync('gofa-points-export: savePath writes the file to disk', async function() {
    var f = path.join(tmpDir, 'export-1.json');
    var mockRobot = { getPoints: function() { return [{ id: 'p1', name: 'p1' }]; } };
    var node = new (loadNodeType('./nodes/gofa-points-export', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: f };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.savedTo, f);
    assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).length, 1);
});
await checkAsync('gofa-points-export: write failure reports an error', async function() {
    var mockRobot = { getPoints: function() { return []; } };
    var node = new (loadNodeType('./nodes/gofa-points-export', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var badPath = path.join(tmpDir, 'nope-dir', 'x.json');
    var err = await runInput(node, { payload: badPath });
    assert.ok(err);
    assert.ok(node.errors.length > 0);
});

// gofa-go-point ──────────────────────────────────────────────────────────────
function makeGoPointRobot(pt) {
    var calls = [];
    return {
        findPoint: function() { return pt; },
        gotoToken: function(target, moveType) { calls.push(moveType); return 'GOTOJ' + JSON.stringify(target); },
        socketSend: function(token) { return Promise.resolve('OK:' + token); },
        _calls: calls
    };
}
await checkAsync('gofa-go-point: uses the configured move type by default', async function() {
    var mockRobot = makeGoPointRobot({ name: 'pick1', target: {} });
    var node = new (loadNodeType('./nodes/gofa-go-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', moveType: 'L' });
    var msg = { payload: {} };
    await runInput(node, msg);
    assert.deepStrictEqual(mockRobot._calls, ['L']);
    assert.strictEqual(msg.payload.moveType, 'L');
});
await checkAsync('gofa-go-point: msg.payload.moveType overrides the configured value', async function() {
    var mockRobot = makeGoPointRobot({ name: 'pick1', target: {} });
    var node = new (loadNodeType('./nodes/gofa-go-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', moveType: 'J' });
    var msg = { payload: { moveType: 'L' } };
    await runInput(node, msg);
    assert.deepStrictEqual(mockRobot._calls, ['L']);
});
await checkAsync('gofa-go-point: invalid msg.payload.moveType falls back to configured value', async function() {
    var mockRobot = makeGoPointRobot({ name: 'pick1', target: {} });
    var node = new (loadNodeType('./nodes/gofa-go-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', moveType: 'L' });
    var msg = { payload: { moveType: 'sideways' } };
    await runInput(node, msg);
    assert.deepStrictEqual(mockRobot._calls, ['L']);
});

// gofa-sequencer + gofa-stop-seq ─────────────────────────────────────────────
function makeSeqRobot(pointMap) {
    var calls = [];
    return {
        _seqStop: false, _seqRunning: false, _calls: calls,
        findPoint: function(name) { return pointMap[name] || null; },
        gotoToken: function(target, moveType) { calls.push(moveType); return 'GOTO' + moveType + JSON.stringify(target); },
        socketSend: function(token) { return Promise.resolve('OK:' + token); }
    };
}
function stepMsgs(node) { return node.sent.filter(function(m) { return m[0]; }).map(function(m) { return m[0]; }); }
function endMsg(node)   { var m = node.sent.filter(function(m) { return m[1]; })[0]; return m && m[1]; }

await checkAsync('gofa-sequencer: runs steps in order and reports done', async function() {
    var points = { pick1: { name: 'pick1', target: { x: 1 } }, pick2: { name: 'pick2', target: { x: 2 } } };
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: makeSeqRobot(points) } }))({ robot: 'r1', dwell: 0 });
    var err = await runInput(node, { payload: { steps: [{ name: 'pick1' }, { name: 'pick2' }] } });
    assert.strictEqual(err, undefined);
    var steps = stepMsgs(node);
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].payload.name, 'pick1');
    assert.strictEqual(steps[1].payload.name, 'pick2');
    assert.deepStrictEqual(endMsg(node).payload, { done: true, loops: 1 });
});
await checkAsync('gofa-sequencer: errors when no valid points are found', async function() {
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: makeSeqRobot({}) } }))({ robot: 'r1', dwell: 0 });
    await runInput(node, { payload: { steps: [{ name: 'missing' }] } });
    assert.ok(node.errors.length > 0);
    assert.strictEqual(node.sent.length, 0);
});
await checkAsync('gofa-sequencer: pingpong mirrors the sequence', async function() {
    var points = { a: { name: 'a', target: {} }, b: { name: 'b', target: {} }, c: { name: 'c', target: {} } };
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: makeSeqRobot(points) } }))({ robot: 'r1', dwell: 0, pingpong: true });
    await runInput(node, { payload: { steps: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } });
    assert.deepStrictEqual(stepMsgs(node).map(function(m) { return m.payload.name; }), ['a', 'b', 'c', 'b', 'a']);
});
await checkAsync('gofa-sequencer: loop respects count', async function() {
    var points = { a: { name: 'a', target: {} } };
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: makeSeqRobot(points) } }))({ robot: 'r1', dwell: 0, loop: true, count: 2 });
    await runInput(node, { payload: { steps: [{ name: 'a' }] } });
    assert.strictEqual(stepMsgs(node).length, 2);
    assert.deepStrictEqual(endMsg(node).payload, { done: true, loops: 2 });
});
await checkAsync('gofa-sequencer: uses the node-level default move type', async function() {
    var points = { a: { name: 'a', target: {} }, b: { name: 'b', target: {} } };
    var mockRobot = makeSeqRobot(points);
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: mockRobot } }))({ robot: 'r1', dwell: 0, moveType: 'L' });
    await runInput(node, { payload: { steps: [{ name: 'a' }, { name: 'b' }] } });
    assert.deepStrictEqual(mockRobot._calls, ['L', 'L']);
    assert.strictEqual(stepMsgs(node)[0].payload.moveType, 'L');
});
await checkAsync('gofa-sequencer: a per-step move type overrides the default', async function() {
    var points = { a: { name: 'a', target: {} }, b: { name: 'b', target: {} } };
    var mockRobot = makeSeqRobot(points);
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: mockRobot } }))({ robot: 'r1', dwell: 0, moveType: 'J' });
    await runInput(node, { payload: { steps: [{ name: 'a', moveType: 'L' }, { name: 'b' }] } });
    assert.deepStrictEqual(mockRobot._calls, ['L', 'J']);
});
await checkAsync('gofa-sequencer: stops early once _seqStop is set', async function() {
    var points = { a: { name: 'a', target: {} }, b: { name: 'b', target: {} }, c: { name: 'c', target: {} } };
    var mockRobot = makeSeqRobot(points);
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: mockRobot } }))({ robot: 'r1', dwell: 5 });
    var runPromise = runInput(node, { payload: { steps: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } });
    await Promise.resolve(); await Promise.resolve(); // let step 1's socketSend().then() fire
    mockRobot._seqStop = true;                          // before the dwell timer for step 2 elapses
    await runPromise;
    assert.strictEqual(stepMsgs(node).length, 1);
    assert.strictEqual(endMsg(node).payload.stopped, true);
});
await checkAsync('gofa-stop-seq: sets the stop flag and sends STOP', async function() {
    var sentCmds = [];
    var mockRobot = { _seqStop: false, socketSend: function(cmd) { sentCmds.push(cmd); return Promise.resolve('OK:STOP'); } };
    var node = new (loadNodeType('./nodes/gofa-stop-seq', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    await runInput(node, {});
    assert.strictEqual(mockRobot._seqStop, true);
    assert.deepStrictEqual(sentCmds, ['STOP']);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed.');
if (failed) process.exit(1);

})();

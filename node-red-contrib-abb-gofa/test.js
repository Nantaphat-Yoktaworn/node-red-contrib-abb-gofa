'use strict';
var assert = require('assert');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var http   = require('http');
var robot  = require('./nodes/gofa-robot');
var gotoToken           = robot.gotoToken;
var gotoObj             = robot.gotoObj;
var parseXhtml          = robot.parseXhtml;
var atomicWriteFileSync = robot.atomicWriteFileSync;
var fileMtimeMs         = robot.fileMtimeMs;
var resolveMoveType     = robot.resolveMoveType;
var createRobotClient   = robot.createRobotClient;
var patchServerIp       = require('./nodes/lib/patch-server-ip');
var parseLiSpans        = require('./nodes/gofa-rapid-tasks').parseLiSpans;
var gate                = require('./nodes/lib/gate');

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
        httpAdmin: { get: function() {}, post: function() {} },
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

check('gotoObj: valid target produces gotoj object by default', function() {
    var obj = gotoObj(sample);
    assert.strictEqual(obj.cmd, 'gotoj');
    assert.strictEqual(obj.val.length, 11);
    assert.strictEqual(obj.val[0], 323.2);
});

check('gotoObj: moveType "L" produces gotol object', function() {
    var obj = gotoObj(sample, 'L');
    assert.strictEqual(obj.cmd, 'gotol');
});

check('gotoObj: unrecognized moveType falls back to gotoj', function() {
    var obj = gotoObj(sample, 'bogus');
    assert.strictEqual(obj.cmd, 'gotoj');
});

check('gotoObj: returns null when any value is NaN', function() {
    var bad = Object.assign({}, sample, { q1: NaN });
    assert.strictEqual(gotoObj(bad), null);
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

// ── gofa-rapid-tasks: parseLiSpans (real RWS response samples) ──────────────
var tasksBody = '<ul><li class="rap-task-li" title="SC_CBC"> <a href="tasks/SC_CBC" rel="self"></a> <span class="name">SC_CBC</span> <span class="type">semistatic</span><span class="taskstate">initiated</span><span class="excstate">started</span></li> <li class="rap-task-li" title="T_ROB1"> <a href="tasks/T_ROB1" rel="self"></a> <span class="name">T_ROB1</span> <span class="type">normal</span><span class="taskstate">initiated</span><span class="excstate">started</span> <span class="active">On</span><span class="motiontask">TRUE</span></li></ul>';
var modulesBody = '<ul><li class="rap-module-info-li" title="T_ROB1/BASE"><span class="name">BASE</span><span class="type">SysMod</span></li><li class="rap-module-info-li" title="T_ROB1/MainModule"><span class="name">MainModule</span><span class="type">ProgMod</span></li></ul>';

check('parseLiSpans: extracts one object per task li, only listed fields', function() {
    var tasks = parseLiSpans(tasksBody, 'rap-task-li', ['name', 'type', 'taskstate', 'excstate', 'active', 'motiontask']);
    assert.strictEqual(tasks.length, 2);
    assert.deepStrictEqual(tasks[0], { name: 'SC_CBC', type: 'semistatic', taskstate: 'initiated', excstate: 'started' });
    assert.deepStrictEqual(tasks[1], { name: 'T_ROB1', type: 'normal', taskstate: 'initiated', excstate: 'started', active: 'On', motiontask: 'TRUE' });
});
check('parseLiSpans: extracts modules with a different li class/field set', function() {
    var modules = parseLiSpans(modulesBody, 'rap-module-info-li', ['name', 'type']);
    assert.deepStrictEqual(modules, [{ name: 'BASE', type: 'SysMod' }, { name: 'MainModule', type: 'ProgMod' }]);
});
check('parseLiSpans: returns empty array when no matching li blocks', function() {
    assert.deepStrictEqual(parseLiSpans('<ul></ul>', 'rap-task-li', ['name']), []);
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

// ── gofa-file: SERVER_IP injection ────────────────────────────────────
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

// ── gofa-egm (EGM protobuf codec) ────────────────────────────────────────────
var egm             = require('./nodes/gofa-egm');
var decodeEgmRobot  = egm.decodeEgmRobot;
var encodeEgmSensor = egm.encodeEgmSensor;

// Reference bytes generated once by the proven gofa-egm-python project's
// egm_pb2 (compiled from ABB's own egm.proto via grpcio-tools) — proves this
// hand-rolled codec is wire-compatible with a real protobuf implementation,
// not just internally self-consistent.
//   EgmRobot{ header{seqno:42, tm:1000}, feedBack.joints:[1..6],
//             planned.joints:[1.1,2.1,3.1,4.1,5.1,6.1], motorState:MOTORS_ON,
//             mciState:MCI_RUNNING, mciConvergenceMet:true }
var REF_ROBOT_HEX = '0a05082a10e80712380a3609000000000000f03f090000000000000040' +
    '09000000000000084009000000000000104009000000000000144009000000000000' +
    '18401a380a36099a9999999999f13f09cdcccccccccc004009cdcccccccccc084009' +
    '6666666666661040096666666666661440096666666666661840220208012a02080' +
    '33001';
// EgmSensor{ header{seqno:42, mtype:MSGTYPE_CORRECTION}, planned.joints:[1.1..6.1] }
var REF_SENSOR_HEX = '0a04082a180312380a36099a9999999999f13f09cdcccccccccc004009' +
    'cdcccccccccc08400966666666666610400966666666666614400966666666666618' +
    '40';

check('decodeEgmRobot: decodes every field from a real egm_pb2-generated message', function() {
    var out = decodeEgmRobot(Buffer.from(REF_ROBOT_HEX, 'hex'));
    assert.strictEqual(out.seqno, 42);
    assert.strictEqual(out.tm, 1000);
    assert.deepStrictEqual(out.feedbackJoints, [1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(out.plannedJoints, [1.1, 2.1, 3.1, 4.1, 5.1, 6.1]);
    assert.strictEqual(out.motorsOn, true);
    assert.strictEqual(out.mciState, 3); // MCI_RUNNING
    assert.strictEqual(out.convergence, true);
});

check('encodeEgmSensor: byte-for-byte match with egm_pb2 reference output', function() {
    var buf = encodeEgmSensor(42, [1.1, 2.1, 3.1, 4.1, 5.1, 6.1]);
    assert.strictEqual(buf.toString('hex'), REF_SENSOR_HEX);
});

check('EGM codec: encode -> decode round trip preserves seqno and joints', function() {
    // EgmSensor.planned is field 2, which happens to be EgmRobot.feedBack's
    // field number too — both wrap the identical EgmJoints{repeated double}
    // shape, so decodeEgmRobot's feedBack parsing can read an encoded
    // EgmSensor back for a structural round-trip check with no extra decoder.
    var sent = encodeEgmSensor(7, [10, -20.5, 30, -40, 50.25, -60]);
    var back = decodeEgmRobot(sent);
    assert.strictEqual(back.seqno, 7);
    assert.deepStrictEqual(back.feedbackJoints, [10, -20.5, 30, -40, 50.25, -60]);
});

check('EGM codec: decodes a packed (length-delimited) repeated double the same as unpacked', function() {
    // proto2 default is unpacked (see REF_ROBOT_HEX), but a decoder must also
    // accept the packed alternative — build one by hand: EgmRobot.feedBack=2{
    // joints=1{ joints=1 (packed 6 doubles) } }.
    var packedDoubles = Buffer.concat([1, 2, 3, 4, 5, 6].map(function(v) {
        var b = Buffer.alloc(8); b.writeDoubleLE(v, 0); return b;
    }));
    var jointsMsg  = Buffer.concat([Buffer.from([0x0a, packedDoubles.length]), packedDoubles]); // tag(1,2)+len+data
    var feedBackMsg = Buffer.concat([Buffer.from([0x0a, jointsMsg.length]), jointsMsg]);
    var top = Buffer.concat([Buffer.from([0x12, feedBackMsg.length]), feedBackMsg]); // tag(2,2)
    var out = decodeEgmRobot(top);
    assert.deepStrictEqual(out.feedbackJoints, [1, 2, 3, 4, 5, 6]);
});

check('encodeEgmSensor: rejects a joints array that is not length 6', function() {
    assert.throws(function() { encodeEgmSensor(1, [1, 2, 3]); });
});
check('encodeEgmSensor: rejects non-finite values', function() {
    assert.throws(function() { encodeEgmSensor(1, [1, 2, 3, 4, 5, NaN]); });
});

check('decodeEgmRobot: empty buffer decodes to empty/default fields, does not throw', function() {
    var out = decodeEgmRobot(Buffer.alloc(0));
    assert.strictEqual(out.seqno, 0);
    assert.deepStrictEqual(out.feedbackJoints, []);
});

// ── async node tests (drive the real 'input' handlers) ──────────────────────
(async function() {

// gofa-points ─────────────────────────────────────────────────────────
await checkAsync('gofa-points: array payload replaces points', async function() {
    var mockRobot = { _points: [{ id: 'old', name: 'old' }], _savePoints: function() { this._saved = true; }, replacePoints: function(arr) { this._points = arr; this._savePoints(); return arr; } };
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'import' });
    var msg = { payload: [{ id: 'p1', name: 'p1', target: {} }] };
    await runInput(node, msg);
    assert.strictEqual(mockRobot._points.length, 1);
    assert.strictEqual(mockRobot._points[0].name, 'p1');
    assert.ok(mockRobot._saved);
    assert.deepStrictEqual(msg.payload, { ok: true, count: 1, loadedFrom: null });
});
await checkAsync('gofa-points: {points:[...]} wrapper is unwrapped', async function() {
    var mockRobot = { _points: [], _savePoints: function() {}, replacePoints: function(arr) { this._points = arr; this._savePoints(); return arr; } };
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'import' });
    await runInput(node, { payload: { points: [{ id: 'p1', name: 'p1' }] } });
    assert.strictEqual(mockRobot._points.length, 1);
});
await checkAsync('gofa-points: loads from a file path in msg.payload', async function() {
    var f = path.join(tmpDir, 'import-1.json');
    fs.writeFileSync(f, JSON.stringify([{ id: 'p1', name: 'p1' }]));
    var mockRobot = { _points: [], _savePoints: function() {}, replacePoints: function(arr) { this._points = arr; this._savePoints(); return arr; } };
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'import' });
    var msg = { payload: f };
    await runInput(node, msg);
    assert.strictEqual(mockRobot._points.length, 1);
    assert.strictEqual(msg.payload.loadedFrom, f);
});
await checkAsync('gofa-points: missing file reports an error', async function() {
    var mockRobot = { _points: [], _savePoints: function() {}, replacePoints: function(arr) { this._points = arr; this._savePoints(); return arr; } };
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'import' });
    var err = await runInput(node, { payload: path.join(tmpDir, 'missing.json') });
    assert.ok(err);
    assert.ok(node.errors.length > 0);
});
await checkAsync('gofa-points: missing robot config reports an error', async function() {
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: {} }))({ robot: 'nope', action: 'import' });
    await runInput(node, { payload: [] });
    assert.ok(node.errors.length > 0);
});
await checkAsync('gofa-points: importing missing target is rejected', async function() {
    var pointsFile = path.join(tmpDir, 'points-import-invalid.json');
    fs.writeFileSync(pointsFile, JSON.stringify([{ id: 'old', name: 'old', target: sample }]));
    var robotNode = makeRobotNode(pointsFile);
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: robotNode } }))({ robot: 'r1', action: 'import' });
    var err = await runInput(node, { payload: [{ name: 'p1' }] });
    assert.ok(err);
    assert.ok(node.errors.length > 0);
    assert.strictEqual(robotNode.getPoints().length, 1);
    assert.strictEqual(robotNode.getPoints()[0].name, 'old');
});
await checkAsync('gofa-points: importing non-numeric target field is rejected', async function() {
    var pointsFile = path.join(tmpDir, 'points-import-nonnum.json');
    fs.writeFileSync(pointsFile, JSON.stringify([{ id: 'old', name: 'old', target: sample }]));
    var robotNode = makeRobotNode(pointsFile);
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: robotNode } }))({ robot: 'r1', action: 'import' });
    var invalidPoints = [{ name: 'p1', target: { x: 'abc', y: 0, z: 0, q1: 0, q2: 0, q3: 0, q4: 0, cf1: 0, cf4: 0, cf6: 0, cfx: 0 } }];
    var err = await runInput(node, { payload: invalidPoints });
    assert.ok(err);
    assert.ok(node.errors.length > 0);
    assert.strictEqual(robotNode.getPoints().length, 1);
    assert.strictEqual(robotNode.getPoints()[0].name, 'old');
});
await checkAsync('gofa-points: importing fully valid array succeeds', async function() {
    var pointsFile = path.join(tmpDir, 'points-import-valid.json');
    fs.writeFileSync(pointsFile, JSON.stringify([]));
    var robotNode = makeRobotNode(pointsFile);
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: robotNode } }))({ robot: 'r1', action: 'import' });
    var validPoints = [{ id: 'p1', name: 'p1', target: sample }];
    var msg = { payload: validPoints };
    await runInput(node, msg);
    assert.strictEqual(robotNode.getPoints().length, 1);
    assert.strictEqual(robotNode.getPoints()[0].name, 'p1');
    assert.deepStrictEqual(msg.payload, { ok: true, count: 1, loadedFrom: null });
});
await checkAsync('gofa-points: importing valid element missing id auto-assigns id', async function() {
    var pointsFile = path.join(tmpDir, 'points-import-missingid.json');
    fs.writeFileSync(pointsFile, JSON.stringify([]));
    var robotNode = makeRobotNode(pointsFile);
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: robotNode } }))({ robot: 'r1', action: 'import' });
    var validPoints = [{ name: 'p1', target: sample }, { name: 'p2', target: sample }];
    await runInput(node, { payload: validPoints });
    var pts = robotNode.getPoints();
    assert.strictEqual(pts.length, 2);
    assert.strictEqual(pts[0].name, 'p1');
    assert.ok(pts[0].id.startsWith('p'));
    assert.strictEqual(pts[1].name, 'p2');
    assert.ok(pts[1].id.startsWith('p'));
    assert.notStrictEqual(pts[0].id, pts[1].id, 'auto-assigned IDs should not collide');
});

// gofa-points ─────────────────────────────────────────────────────────
await checkAsync('gofa-points export: no savePath just outputs the points', async function() {
    var mockRobot = { getPoints: function() { return [{ id: 'p1', name: 'p1' }]; } };
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: null };
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload.points, [{ id: 'p1', name: 'p1' }]);
    assert.strictEqual(msg.payload.savedTo, undefined);
});
await checkAsync('gofa-points export: savePath writes the file to disk', async function() {
    var f = path.join(tmpDir, 'export-1.json');
    var mockRobot = { getPoints: function() { return [{ id: 'p1', name: 'p1' }]; } };
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: f };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.savedTo, f);
    assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).length, 1);
});
await checkAsync('gofa-points export: write failure reports an error', async function() {
    var mockRobot = { getPoints: function() { return []; } };
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var badPath = path.join(tmpDir, 'nope-dir', 'x.json');
    var err = await runInput(node, { payload: badPath });
    assert.ok(err);
    assert.ok(node.errors.length > 0);
});

// gofa-robot: remote (on-robot) point management ────────────────────────────
// Mocks requestRaw/rwsPut directly on a real gofa-robot instance — these are
// the only two methods remoteGetPoints/remoteAddPoint/etc actually call, so
// this exercises the real remote* method bodies, not a reimplementation.
function makeRemoteRobotNode(fileState) {
    var node = makeRobotNode(path.join(tmpDir, 'unused-remote-points.json'));
    var stored = fileState.exists ? JSON.stringify(fileState.points || []) : null;
    node.requestRaw = function(method) {
        if (method !== 'GET') return Promise.reject(new Error('unexpected requestRaw ' + method));
        if (stored === null) return Promise.resolve({ statusCode: 404, headers: {}, body: Buffer.from('') });
        return Promise.resolve({ statusCode: 200, headers: {}, body: Buffer.from(stored) });
    };
    node.rwsPut = function(path, body) { stored = body; return Promise.resolve(''); };
    node._getStored = function() { return stored; };
    return node;
}

await checkAsync('gofa-robot: remoteGetPoints returns [] when the file does not exist (404)', async function() {
    var node = makeRemoteRobotNode({ exists: false });
    assert.deepStrictEqual(await node.remoteGetPoints(), []);
});
await checkAsync('gofa-robot: remoteAddPoint auto-names and persists via rwsPut', async function() {
    var node = makeRemoteRobotNode({ exists: false });
    var p1 = await node.remoteAddPoint('', { x: 1 });
    assert.strictEqual(p1.name, 'Point 1');
    var stored = JSON.parse(node._getStored());
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].name, 'Point 1');
});
await checkAsync('gofa-robot: remoteAddPoint rejects duplicate names', async function() {
    var node = makeRemoteRobotNode({ exists: true, points: [{ id: 'p1', name: 'pick1', target: {} }] });
    var res = await node.remoteAddPoint('pick1', { x: 2 });
    assert.ok(res.error);
});
await checkAsync('gofa-robot: remoteDeletePoint removes by name and persists', async function() {
    var node = makeRemoteRobotNode({ exists: true, points: [{ id: 'p1', name: 'pick1', target: {} }] });
    var deleted = await node.remoteDeletePoint('pick1');
    assert.strictEqual(deleted.name, 'pick1');
    assert.deepStrictEqual(JSON.parse(node._getStored()), []);
});
await checkAsync('gofa-robot: remoteDeletePoint returns null when not found', async function() {
    var node = makeRemoteRobotNode({ exists: true, points: [] });
    assert.strictEqual(await node.remoteDeletePoint('missing'), null);
});
await checkAsync('gofa-robot: remoteAddPoint warns (but still saves) if the remote file changed between the initial read and the pre-save check', async function() {
    var node = makeRemoteRobotNode({ exists: true, points: [{ id: 'p1', name: 'existing', target: {} }] });
    var getCount = 0;
    var realRequestRaw = node.requestRaw;
    node.requestRaw = function(method) {
        getCount++;
        if (getCount === 2) {
            // Simulate a concurrent write landing between remoteAddPoint's initial
            // read and its pre-save drift check.
            return Promise.resolve({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify([
                { id: 'p1', name: 'existing', target: {} }, { id: 'p2', name: 'concurrent', target: {} }
            ])) });
        }
        return realRequestRaw(method);
    };
    var pt = await node.remoteAddPoint('new-point', { x: 1 });
    assert.strictEqual(pt.name, 'new-point');
    assert.ok(node.warnings.some(function(w) { return /changed since it was last read/.test(w); }),
        'must warn that the remote file changed since it was last read');
});
await checkAsync('gofa-robot: remoteAddPoint does NOT warn about drift when nothing changed between reads', async function() {
    var node = makeRemoteRobotNode({ exists: true, points: [{ id: 'p1', name: 'existing', target: {} }] });
    await node.remoteAddPoint('new-point', { x: 1 });
    assert.ok(!node.warnings.some(function(w) { return /changed since it was last read/.test(w); }),
        'must not warn when the remote file is unchanged between the two reads');
});
await checkAsync('gofa-robot: remoteFindPoint matches by name or id, else null', async function() {
    var node = makeRemoteRobotNode({ exists: true, points: [{ id: 'p1', name: 'pick1', target: { x: 1 } }] });
    assert.strictEqual((await node.remoteFindPoint('pick1')).name, 'pick1');
    assert.strictEqual((await node.remoteFindPoint('p1')).name, 'pick1');
    assert.strictEqual(await node.remoteFindPoint('nope'), null);
});

// gofa-go-point ──────────────────────────────────────────────────────────────
function makeGoPointRobot(pt) {
    var calls = [];
    return {
        findPoint: function() { return pt; },
        gotoObj: function(target, moveType) { calls.push(moveType); return { cmd: 'goto' + (moveType || 'j').toLowerCase(), val: [] }; },
        socketSend: function(obj) { return Promise.resolve('OK:GOTO'); },
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
await checkAsync('gofa-go-point: storage "remote" looks the point up via remoteFindPoint', async function() {
    var calls = [];
    var mockRobot = {
        findPoint: function() { throw new Error('must not use local findPoint in remote mode'); },
        remoteFindPoint: function(name) { calls.push(name); return Promise.resolve({ name: 'pick1', target: {} }); },
        gotoObj: function() { return { cmd: 'gotoj', val: [] }; },
        socketSend: function(obj) { return Promise.resolve('OK:GOTO'); }
    };
    var node = new (loadNodeType('./nodes/gofa-go-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', storage: 'remote', pointName: 'pick1' });
    var msg = {};
    await runInput(node, msg);
    assert.deepStrictEqual(calls, ['pick1']);
    assert.strictEqual(msg.payload.ok, true);
});

// gofa-save-point ────────────────────────────────────────────────────────────
var samplePoseBody = '<span class="x">1</span><span class="y">2</span><span class="z">3</span>' +
    '<span class="q1">0</span><span class="q2">0</span><span class="q3">0</span><span class="q4">1</span>' +
    '<span class="cf1">0</span><span class="cf4">0</span><span class="cf6">0</span><span class="cfx">0</span>';
await checkAsync('gofa-save-point: storage "local" (default) uses addPoint/getPoints', async function() {
    var calls = [];
    var mockRobot = {
        rwsGet: function() { return Promise.resolve(samplePoseBody); },
        parseXhtml: parseXhtml,
        addPoint: function(name, target) { calls.push(['add', name, target]); return { id: 'p1', name: 'pick1', target: target }; },
        getPoints: function() { return [{ id: 'p1', name: 'pick1' }]; }
    };
    var node = new (loadNodeType('./nodes/gofa-save-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', pointName: 'pick1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.point.name, 'pick1');
    assert.strictEqual(calls[0][0], 'add');
});
await checkAsync('gofa-save-point: storage "remote" uses remoteAddPoint/remoteGetPoints', async function() {
    var calls = [];
    var mockRobot = {
        rwsGet: function() { return Promise.resolve(samplePoseBody); },
        parseXhtml: parseXhtml,
        addPoint: function() { throw new Error('must not use local addPoint in remote mode'); },
        remoteAddPoint: function(name, target) { calls.push(['add', name, target]); return Promise.resolve({ id: 'p1', name: 'pick1', target: target }); },
        remoteGetPoints: function() { return Promise.resolve([{ id: 'p1', name: 'pick1' }]); }
    };
    var node = new (loadNodeType('./nodes/gofa-save-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', storage: 'remote', pointName: 'pick1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.point.name, 'pick1');
    assert.strictEqual(msg.payload.points.length, 1);
    assert.strictEqual(calls[0][0], 'add');
});
await checkAsync('gofa-save-point: storage "remote" surfaces a duplicate-name error', async function() {
    var mockRobot = {
        rwsGet: function() { return Promise.resolve(samplePoseBody); },
        parseXhtml: parseXhtml,
        remoteAddPoint: function() { return Promise.resolve({ error: 'A point named "pick1" already exists' }); }
    };
    var node = new (loadNodeType('./nodes/gofa-save-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', storage: 'remote', pointName: 'pick1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('already exists') >= 0);
});

// gofa-delete-point ──────────────────────────────────────────────────────────
await checkAsync('gofa-delete-point: storage "local" (default) uses findPoint/deletePoint', async function() {
    var deletedId;
    var mockRobot = {
        findPoint: function(name) { return name === 'pick1' ? { id: 'p1', name: 'pick1' } : null; },
        deletePoint: function(id) { deletedId = id; },
        getPoints: function() { return []; }
    };
    var node = new (loadNodeType('./nodes/gofa-delete-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', pointName: 'pick1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(deletedId, 'p1');
});
await checkAsync('gofa-delete-point: storage "remote" uses remoteFindPoint/remoteDeletePoint', async function() {
    var deletedId;
    var mockRobot = {
        findPoint: function() { throw new Error('must not use local findPoint in remote mode'); },
        remoteFindPoint: function(name) { return Promise.resolve(name === 'pick1' ? { id: 'p1', name: 'pick1' } : null); },
        remoteDeletePoint: function(id) { deletedId = id; return Promise.resolve({ id: id, name: 'pick1' }); },
        remoteGetPoints: function() { return Promise.resolve([]); }
    };
    var node = new (loadNodeType('./nodes/gofa-delete-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', storage: 'remote', pointName: 'pick1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(deletedId, 'p1');
    assert.deepStrictEqual(msg.payload.points, []);
});
await checkAsync('gofa-delete-point: reports "not found" without touching remoteDeletePoint', async function() {
    var mockRobot = {
        remoteFindPoint: function() { return Promise.resolve(null); },
        remoteDeletePoint: function() { throw new Error('must not delete when point was not found'); }
    };
    var node = new (loadNodeType('./nodes/gofa-delete-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', storage: 'remote', pointName: 'missing' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('not found') >= 0);
});

// gofa-point-list ────────────────────────────────────────────────────────────
await checkAsync('gofa-point-list: storage "local" (default) uses getPoints', async function() {
    var mockRobot = { getPoints: function() { return [{ id: 'p1', name: 'pick1' }]; } };
    var node = new (loadNodeType('./nodes/gofa-point-list', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.length, 1);
});
await checkAsync('gofa-point-list: storage "remote" uses remoteGetPoints', async function() {
    var mockRobot = {
        getPoints: function() { throw new Error('must not use local getPoints in remote mode'); },
        remoteGetPoints: function() { return Promise.resolve([{ id: 'p1', name: 'pick1' }, { id: 'p2', name: 'pick2' }]); }
    };
    var node = new (loadNodeType('./nodes/gofa-point-list', { nodesById: { r1: mockRobot } }))({ robot: 'r1', storage: 'remote' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.length, 2);
});

// gofa-sequencer + gofa-stop-seq ─────────────────────────────────────────────
function makeSeqRobot(pointMap) {
    var calls = [];
    return {
        _seqStop: false, _seqRunning: false, _calls: calls,
        findPoint: function(name) { return pointMap[name] || null; },
        getPoints: function() { return Object.keys(pointMap).map(function(k) { return pointMap[k]; }); },
        gotoObj: function(target, moveType) { calls.push(moveType); return { cmd: 'goto' + (moveType || 'j').toLowerCase(), val: [] }; },
        socketSend: function(obj) { return Promise.resolve('OK:GOTO'); }
    };
}
function stepMsgs(node) { return node.sent.filter(function(m) { return m[0]; }).map(function(m) { return m[0]; }); }
function endMsg(node)   { var m = node.sent.filter(function(m) { return m[1]; })[0]; return m && m[1]; }

await checkAsync('gofa-sequencer: runs steps in order and reports done', async function() {
    var points = { pick1: { name: 'pick1', target: { x: 1 } }, pick2: { name: 'pick2', target: { x: 2 } } };
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: makeSeqRobot(points) } }))({ robot: 'r1', dwell: 0, outputPayload: true });
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
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: makeSeqRobot(points) } }))({ robot: 'r1', dwell: 0, pingpong: true, outputPayload: true });
    await runInput(node, { payload: { steps: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } });
    assert.deepStrictEqual(stepMsgs(node).map(function(m) { return m.payload.name; }), ['a', 'b', 'c', 'b', 'a']);
});
await checkAsync('gofa-sequencer: loop respects count', async function() {
    var points = { a: { name: 'a', target: {} } };
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: makeSeqRobot(points) } }))({ robot: 'r1', dwell: 0, loop: true, count: 2, outputPayload: true });
    await runInput(node, { payload: { steps: [{ name: 'a' }] } });
    assert.strictEqual(stepMsgs(node).length, 2);
    assert.deepStrictEqual(endMsg(node).payload, { done: true, loops: 2 });
});
await checkAsync('gofa-sequencer: uses the node-level default move type', async function() {
    var points = { a: { name: 'a', target: {} }, b: { name: 'b', target: {} } };
    var mockRobot = makeSeqRobot(points);
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: mockRobot } }))({ robot: 'r1', dwell: 0, moveType: 'L', outputPayload: true });
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
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: mockRobot } }))({ robot: 'r1', dwell: 5, outputPayload: true });
    var runPromise = runInput(node, { payload: { steps: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } });
    await Promise.resolve(); await Promise.resolve(); // let step 1's socketSend().then() fire
    mockRobot._seqStop = true;                          // before the dwell timer for step 2 elapses
    await runPromise;
    assert.strictEqual(stepMsgs(node).length, 1);
    assert.strictEqual(endMsg(node).payload.stopped, true);
});
await checkAsync('gofa-sequencer: storage "remote" fetches the point list once via remoteGetPoints, not getPoints', async function() {
    var getPointsCalls = 0, remoteGetPointsCalls = 0;
    var mockRobot = {
        _seqStop: false, _seqRunning: false,
        getPoints: function() { getPointsCalls++; return []; },
        remoteGetPoints: function() { remoteGetPointsCalls++; return Promise.resolve([{ name: 'a', target: {} }, { name: 'b', target: {} }]); },
        gotoObj: function() { return { cmd: 'gotoj', val: [] }; },
        socketSend: function(obj) { return Promise.resolve('OK:GOTO'); }
    };
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: mockRobot } }))({ robot: 'r1', storage: 'remote', dwell: 0, outputPayload: true });
    await runInput(node, { payload: { steps: [{ name: 'a' }, { name: 'b' }] } });
    assert.strictEqual(remoteGetPointsCalls, 1, 'must fetch the remote list exactly once for the whole sequence');
    assert.strictEqual(getPointsCalls, 0, 'must not touch local getPoints in remote mode');
    assert.strictEqual(stepMsgs(node).length, 2);
    assert.deepStrictEqual(endMsg(node).payload, { done: true, loops: 1 });
});
await checkAsync('gofa-sequencer: race condition guard prevents concurrent sequences', async function() {
    var remoteGetPointsCalls = 0;
    var socketSendCalls = [];
    var resolvePoints;
    var pointsPromise = new Promise(function(resolve) {
        resolvePoints = resolve;
    });
    var mockRobot = {
        _seqStop: false, _seqRunning: false,
        getPoints: function() { return []; },
        remoteGetPoints: function() {
            remoteGetPointsCalls++;
            return pointsPromise;
        },
        gotoObj: function() { return { cmd: 'gotoj', val: [] }; },
        socketSend: function(obj) {
            socketSendCalls.push(obj);
            return Promise.resolve('OK:GOTO');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-sequencer', { nodesById: { r1: mockRobot } }))({ robot: 'r1', storage: 'remote', dwell: 0 });

    var run1 = runInput(node, { payload: { steps: [{ name: 'a' }] } });
    var run2 = runInput(node, { payload: { steps: [{ name: 'a' }] } });

    resolvePoints([{ name: 'a', target: {} }]);
    await run1;
    await run2;

    assert.strictEqual(remoteGetPointsCalls, 1, 'should only fetch points once');
    assert.strictEqual(node.warnings.some(function(w) { return w.includes('Sequence already running'); }), true);
});
await checkAsync('gofa-stop-seq: sets the stop flag and sends STOP', async function() {
    var sentCmds = [];
    var mockRobot = { _seqStop: false, socketSend: function(cmd) { sentCmds.push(cmd); return Promise.resolve('OK:STOP'); } };
    var node = new (loadNodeType('./nodes/gofa-stop-seq', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    await runInput(node, {});
    assert.strictEqual(mockRobot._seqStop, true);
    assert.deepStrictEqual(sentCmds, [{ cmd: 'stop' }]);
});

// gofa-file: node-level tests go through r.rwsPut() (the public API),
// not private robot internals like r._getSession/r._cookie — a mock robot only
// exposing what the real GoFaRobotNode exposes is what would have caught the
// "r._getSession is not a function" regression from a gofa-robot.js refactor
// that moved session/cookie state into a private createRobotClient() closure.
await checkAsync('gofa-file: uploads via r.rwsPut with text/plain content type', async function() {
    var calls = [];
    var mockRobot = {
        ip: '10.0.0.9',
        rwsPut: function(p, b, contentType) {
            calls.push({ path: p, body: b, contentType: contentType });
            return Promise.resolve('');
        }
    };
    var tmpFile = path.join(tmpDir, 'MainModule.mod');
    fs.writeFileSync(tmpFile, sampleMod);
    var node = new (loadNodeType('./nodes/gofa-file', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', action: 'upload', localPath: tmpFile, remotePath: '$HOME/Programs/MainModule.mod', autoChangeIp: true
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].path, '/fileservice/$HOME/Programs/MainModule.mod');
    assert.strictEqual(calls[0].contentType, 'text/plain;v=2.0');
    assert.ok(calls[0].body.toString().indexOf('"10.0.0.9"') >= 0, 'SERVER_IP should be patched to the robot ip');
});
await checkAsync('gofa-file: uploads via r.rwsPut without SERVER_IP patched when autoChangeIp is false (default)', async function() {
    var calls = [];
    var mockRobot = {
        ip: '10.0.0.9',
        rwsPut: function(p, b, contentType) {
            calls.push({ path: p, body: b, contentType: contentType });
            return Promise.resolve('');
        }
    };
    var tmpFile = path.join(tmpDir, 'MainModule2.mod');
    fs.writeFileSync(tmpFile, sampleMod);
    var node = new (loadNodeType('./nodes/gofa-file', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', action: 'upload', localPath: tmpFile, remotePath: '$HOME/Programs/MainModule.mod'
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].path, '/fileservice/$HOME/Programs/MainModule.mod');
    assert.strictEqual(calls[0].contentType, 'text/plain;v=2.0');
    assert.ok(calls[0].body.toString().indexOf('"192.168.20.15"') >= 0, 'SERVER_IP should not be patched and stay at default');
});
await checkAsync('gofa-file: reports failure when rwsPut rejects', async function() {
    var mockRobot = { ip: '10.0.0.9', rwsPut: function() { return Promise.reject(new Error('HTTP 401 — auth failed')); } };
    var tmpFile = path.join(tmpDir, 'Other.mod');
    fs.writeFileSync(tmpFile, 'MODULE Other\nENDMODULE\n');
    var node = new (loadNodeType('./nodes/gofa-file', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'upload', localPath: tmpFile });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('401') >= 0);
});

// gofa-rapid-exec ────────────────────────────────────────────────────────────
function makeRapidExecRobot(opts) {
    opts = opts || {};
    var calls = [];
    var execSeq = (opts.execstateSeq || ['running']).slice();
    return {
        calls: calls,
        rwsGet: function(p) {
            calls.push(['GET', p]);
            if (p === '/rw/panel/ctrl-state') return Promise.resolve('CTRLSTATE:' + (opts.ctrlstate || 'motoron'));
            if (p === '/rw/rapid/execution') return Promise.resolve('EXECSTATE:' + (execSeq.length > 1 ? execSeq.shift() : execSeq[0]));
            return Promise.reject(new Error('unexpected GET ' + p));
        },
        rwsPost: function(p, b) {
            calls.push(['POST', p, b]);
            if (opts.postError) return Promise.reject(opts.postError);
            return Promise.resolve('');
        },
        rwsPostHal: function(p, b) {
            calls.push(['POST-HAL', p, b]);
            if (opts.postError) return Promise.reject(opts.postError);
            return Promise.resolve(opts.loadmodResponse || '{"state":[{"name":"MainModule"}]}');
        },
        parseXhtml: function(body) {
            var m = /:(.*)$/.exec(body);
            return m ? m[1] : null;
        },
        withMastership: function(fn) { return fn(); }
    };
}
await checkAsync('gofa-rapid-exec: start refuses up front when motors are off (no POST sent)', async function() {
    var mockRobot = makeRapidExecRobot({ ctrlstate: 'motoroff' });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'start' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('motors are motoroff') >= 0, msg.payload.error);
    assert.strictEqual(msg.payload.ctrlstate, 'motoroff');
    assert.ok(!mockRobot.calls.some(function(c) { return c[0] === 'POST'; }), 'must not POST start when motors are off');
});
await checkAsync('gofa-rapid-exec: start succeeds when motors are on and execstate confirms running', async function() {
    var mockRobot = makeRapidExecRobot({ ctrlstate: 'motoron', execstateSeq: ['running'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'start' });
    var msg = {};
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload, { ok: true, action: 'start' });
    assert.ok(mockRobot.calls.some(function(c) { return c[0] === 'POST' && c[1] === '/rw/rapid/execution/start'; }));
});
await checkAsync('gofa-rapid-exec: start reports failure when execstate never reaches running (silent RWS rejection)', async function() {
    var mockRobot = makeRapidExecRobot({ ctrlstate: 'motoron', execstateSeq: ['stopped'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'start' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('did not start') >= 0, msg.payload.error);
    assert.strictEqual(msg.payload.execstate, 'stopped');
});
await checkAsync('gofa-rapid-exec: stop does not check ctrl-state', async function() {
    var mockRobot = makeRapidExecRobot({ ctrlstate: 'motoroff' });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'stop' });
    var msg = {};
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload, { ok: true, action: 'stop' });
    assert.ok(!mockRobot.calls.some(function(c) { return c[1] === '/rw/panel/ctrl-state'; }));
});
await checkAsync('gofa-rapid-exec: resetpp acquires mastership and does not check ctrl-state', async function() {
    var mockRobot = makeRapidExecRobot({ ctrlstate: 'motoroff' });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'resetpp' });
    var msg = {};
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload, { ok: true, action: 'resetpp' });
});
await checkAsync('gofa-rapid-exec: loadmod refuses up front when RAPID is running (no mastership request sent)', async function() {
    var mockRobot = makeRapidExecRobot({ execstateSeq: ['running'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'loadmod' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('RAPID is running') >= 0, msg.payload.error);
    assert.ok(!mockRobot.calls.some(function(c) { return c[0] === 'POST-HAL'; }), 'must not attempt loadmod when RAPID is running');
});
await checkAsync('gofa-rapid-exec: loadmod acquires mastership, uses hal+json, and parses the loaded module name', async function() {
    var mockRobot = makeRapidExecRobot({ ctrlstate: 'motoroff', execstateSeq: ['stopped'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', action: 'loadmod', task: 'T_ROB1', modulePath: '$HOME/Programs/MainModule.mod', replace: true
    });
    var msg = {};
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload, {
        ok: true, action: 'loadmod', task: 'T_ROB1', modulePath: '$HOME/Programs/MainModule.mod', module: 'MainModule'
    });
    var call = mockRobot.calls.filter(function(c) { return c[0] === 'POST-HAL'; })[0];
    assert.ok(call, 'must call rwsPostHal, not rwsPost, for loadmod');
    assert.strictEqual(call[1], '/rw/rapid/tasks/T_ROB1/loadmod');
    assert.ok(call[2].indexOf('modulepath=') >= 0 && call[2].indexOf('replace=true') >= 0, call[2]);
    assert.ok(!mockRobot.calls.some(function(c) { return c[1] === '/rw/panel/ctrl-state'; }), 'must not check ctrl-state for loadmod (it checks exec-state instead)');
});
await checkAsync('gofa-rapid-exec: msg.payload can override task/modulePath/replace for loadmod', async function() {
    var mockRobot = makeRapidExecRobot({ execstateSeq: ['stopped'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'loadmod' });
    var msg = { payload: { action: 'loadmod', task: 'T_ROB2', modulePath: '$HOME/Programs/Other.mod', replace: false } };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.task, 'T_ROB2');
    var call = mockRobot.calls.filter(function(c) { return c[0] === 'POST-HAL'; })[0];
    assert.strictEqual(call[1], '/rw/rapid/tasks/T_ROB2/loadmod');
    assert.ok(call[2].indexOf('Other.mod') >= 0 && call[2].indexOf('replace=false') >= 0, call[2]);
});
await checkAsync('gofa-rapid-exec: unloadmod acquires mastership, uses hal+json, and reports task/module', async function() {
    var mockRobot = makeRapidExecRobot({ ctrlstate: 'motoroff', execstateSeq: ['stopped'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', action: 'unloadmod', task: 'T_ROB1', module: 'MainModule'
    });
    var msg = {};
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload, { ok: true, action: 'unloadmod', task: 'T_ROB1', module: 'MainModule' });
    var call = mockRobot.calls.filter(function(c) { return c[0] === 'POST-HAL'; })[0];
    assert.ok(call, 'must call rwsPostHal, not rwsPost, for unloadmod');
    assert.strictEqual(call[1], '/rw/rapid/tasks/T_ROB1/unloadmod');
    assert.strictEqual(call[2], 'module=MainModule');
});
await checkAsync('gofa-rapid-exec: unloadmod PGM-state 403 gets the "stop RAPID first" hint (reactive fallback if the proactive check ever misses it)', async function() {
    // Confirmed live: RWS rejects unloadmod with this exact message while RAPID is running.
    // execstateSeq is 'stopped' here specifically so this test exercises the reactive
    // .catch hint independent of the newer proactive check above (which has its own
    // dedicated test) — not because the proactive check is expected to fail in practice.
    var pgmStateError = new Error('HTTP 403 /rw/rapid/tasks/T_ROB1/unloadmod — Operation not allowed for current PGM state (Started/Stopped/Ready)');
    var mockRobot = makeRapidExecRobot({ postError: pgmStateError, execstateSeq: ['stopped'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', action: 'unloadmod', task: 'T_ROB1', module: 'MainModule'
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('RAPID must be stopped for unloadmod') >= 0, msg.payload.error);
});
await checkAsync('gofa-rapid-exec: activate acquires mastership, uses hal+json, and reports task/module', async function() {
    var mockRobot = makeRapidExecRobot({ ctrlstate: 'motoroff', execstateSeq: ['stopped'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', action: 'activate', task: 'T_ROB1', module: 'MainModule'
    });
    var msg = {};
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload, { ok: true, action: 'activate', task: 'T_ROB1', module: 'MainModule' });
    var call = mockRobot.calls.filter(function(c) { return c[0] === 'POST-HAL'; })[0];
    assert.ok(call, 'must call rwsPostHal, not rwsPost, for activate');
    assert.strictEqual(call[1], '/rw/rapid/tasks/T_ROB1/activate');
    assert.strictEqual(call[2], 'module=MainModule');
    assert.ok(!mockRobot.calls.some(function(c) { return c[1] === '/rw/panel/ctrl-state'; }), 'must not check ctrl-state for activate (it checks exec-state instead)');
});
await checkAsync('gofa-rapid-exec: msg.payload can override task/module for activate', async function() {
    var mockRobot = makeRapidExecRobot({ execstateSeq: ['stopped'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'activate' });
    var msg = { payload: { action: 'activate', task: 'T_ROB2', module: 'OtherModule' } };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.task, 'T_ROB2');
    assert.strictEqual(msg.payload.module, 'OtherModule');
    var call = mockRobot.calls.filter(function(c) { return c[0] === 'POST-HAL'; })[0];
    assert.strictEqual(call[1], '/rw/rapid/tasks/T_ROB2/activate');
    assert.strictEqual(call[2], 'module=OtherModule');
});
await checkAsync('gofa-rapid-exec: activate/loadmod give a clear hint on the "RAPID must be stopped" 403 (reactive fallback)', async function() {
    // Confirmed live: RWS rejects activate/loadmod with this exact message while RAPID is running.
    var pgmStateError = new Error('HTTP 403 /rw/rapid/tasks/T_ROB1/activate — Operation not allowed for current PGM state (Started/Stopped/Ready)');
    var mockRobot = makeRapidExecRobot({ postError: pgmStateError, execstateSeq: ['stopped'] });
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'activate' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('RAPID must be stopped for activate') >= 0, msg.payload.error);
});
await checkAsync('gofa-rapid-exec: warns when msg.payload looks like another gofa-rapid-exec node\'s own output ({ok, action}), but still honors the override', async function() {
    var mockRobot = makeRapidExecRobot();
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'start' });
    var msg = { payload: { ok: true, action: 'resetpp' } };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.action, 'resetpp', 'the chained action still overrides, same as before — this only adds a warning');
    assert.ok(node.warnings.some(function(w) { return w.indexOf('another gofa-rapid-exec node') >= 0; }));
});
await checkAsync('gofa-rapid-exec: a plain object payload without both ok+action does not trigger the chaining warning', async function() {
    var mockRobot = makeRapidExecRobot();
    var node = new (loadNodeType('./nodes/gofa-rapid-exec', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'stop' });
    var msg = { payload: { task: 'T_ROB1' } };
    await runInput(node, msg);
    assert.strictEqual(node.warnings.length, 0);
});

// gofa-rapid-tasks ───────────────────────────────────────────────────────────
await checkAsync('gofa-rapid-tasks: reads tasks and the default task\'s modules', async function() {
    var calls = [];
    var mockRobot = {
        rwsGet: function(p) {
            calls.push(p);
            if (p === '/rw/rapid/tasks') return Promise.resolve(tasksBody);
            if (p === '/rw/rapid/tasks/T_ROB1/modules') return Promise.resolve(modulesBody);
            return Promise.reject(new Error('unexpected GET ' + p));
        }
    };
    var node = new (loadNodeType('./nodes/gofa-rapid-tasks', { nodesById: { r1: mockRobot } }))({ robot: 'r1', task: 'T_ROB1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.tasks.length, 2);
    assert.strictEqual(msg.payload.task, 'T_ROB1');
    assert.deepStrictEqual(msg.payload.modules, [{ name: 'BASE', type: 'SysMod' }, { name: 'MainModule', type: 'ProgMod' }]);
    assert.deepStrictEqual(calls, ['/rw/rapid/tasks', '/rw/rapid/tasks/T_ROB1/modules']);
});
await checkAsync('gofa-rapid-tasks: msg.payload.task overrides which task\'s modules are fetched', async function() {
    var requestedModulePath;
    var mockRobot = {
        rwsGet: function(p) {
            if (p === '/rw/rapid/tasks') return Promise.resolve(tasksBody);
            requestedModulePath = p;
            return Promise.resolve('<ul></ul>');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-rapid-tasks', { nodesById: { r1: mockRobot } }))({ robot: 'r1', task: 'T_ROB1' });
    var msg = { payload: { task: 'SC_CBC' } };
    await runInput(node, msg);
    assert.strictEqual(requestedModulePath, '/rw/rapid/tasks/SC_CBC/modules');
    assert.strictEqual(msg.payload.task, 'SC_CBC');
});
await checkAsync('gofa-rapid-tasks: reports failure on RWS error', async function() {
    var mockRobot = { rwsGet: function() { return Promise.reject(new Error('HTTP 500')); } };
    var node = new (loadNodeType('./nodes/gofa-rapid-tasks', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('HTTP 500') >= 0);
});

// gofa-file / gofa-subscribe-io / gofa-subscribe-state ─────────────────
// These three go through robot.requestRaw()/robot.getCookie() (the public API)
// instead of the private robot._getSession/_cookie/_request fields that a
// gofa-robot.js refactor removed — mock robots below deliberately expose only
// the public methods, so a regression back to the private fields fails loudly
// with "... is not a function" instead of silently passing.
async function flush() { for (var i = 0; i < 6; i++) await Promise.resolve(); }

await checkAsync('gofa-file: reads a file via robot.requestRaw, not private robot internals', async function() {
    var calls = [];
    var mockRobot = {
        requestRaw: function(method, p, body, opts) {
            calls.push({ method: method, path: p, opts: opts });
            return Promise.resolve({ statusCode: 200, headers: {}, body: Buffer.from('MODULE Foo\nENDMODULE\n') });
        }
    };
    var node = new (loadNodeType('./nodes/gofa-file', { nodesById: { r1: mockRobot } }))(
        { robot: 'r1', remotePath: '$HOME/Programs/MainModule.mod', encoding: 'utf8' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.content, 'MODULE Foo\nENDMODULE\n');
    assert.strictEqual(msg.payload.localPath, null); // no Local path configured → nothing written to disk
    assert.strictEqual(fs.existsSync('MainModule.mod'), false);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'GET');
    assert.strictEqual(calls[0].path, '/fileservice/$HOME/Programs/MainModule.mod');
});
await checkAsync('gofa-file: reports failure on a non-2xx status', async function() {
    var mockRobot = { requestRaw: function() { return Promise.resolve({ statusCode: 404, headers: {}, body: Buffer.from('') }); } };
    var node = new (loadNodeType('./nodes/gofa-file', { nodesById: { r1: mockRobot } }))({ robot: 'r1', remotePath: 'nope.mod' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('404') >= 0);
});
await checkAsync('gofa-subscribe-io: subscribes via robot.requestRaw (not private robot internals), falls back to polling on HTTP 400', async function() {
    var calls = [];
    var mockRobot = {
        requestRaw: function(method, p, body, opts) {
            calls.push({ method: method, path: p, body: body });
            return Promise.resolve({ statusCode: 400, headers: {}, body: Buffer.from('') });
        },
        getCookie: function() { return Promise.resolve('cookie=abc'); },
        rwsGet: function() { return Promise.resolve('<span class="lvalue">1</span>'); }
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-io', { nodesById: { r1: mockRobot } }))({ robot: 'r1', signal: 'Asi1Button1' });
    var msg = {};
    await runInput(node, msg);
    await flush();
    assert.ok(calls.some(function(c) { return c.method === 'POST' && c.path === '/subscription'; }));
    assert.ok(node._pollTimer, 'must fall back to polling when the subscribe request itself fails with HTTP 400');
    clearInterval(node._pollTimer);
});
await checkAsync('gofa-subscribe-io: subscribe POST resolves after close() does not create WS and deletes orphaned subscription', async function() {
    var deleteCalls = [];
    var resolvePost;
    var postPromise = new Promise(function(resolve) { resolvePost = resolve; });
    var mockRobot = {
        requestRaw: function(method, p, body, opts) {
            if (method === 'POST' && p === '/subscription') {
                return postPromise;
            }
            if (method === 'DELETE' && p.startsWith('/subscription/')) {
                deleteCalls.push(p);
                return Promise.resolve({ statusCode: 200, headers: {}, body: Buffer.from('') });
            }
            return Promise.reject(new Error('unexpected requestRaw ' + method + ' ' + p));
        },
        getCookie: function() { return Promise.resolve('cookie=abc'); }
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-io', { nodesById: { r1: mockRobot } }))({ robot: 'r1', signal: 'Asi1Button1' });
    
    runInput(node, {});
    node._handlers['close'](function() {});
    resolvePost({ statusCode: 201, headers: { location: 'http://localhost/poll/abc' } });
    await flush();
    
    assert.strictEqual(node._ws, null, 'WS should not have been created');
    assert.strictEqual(deleteCalls.length, 1, 'orphaned subscription should be deleted');
    assert.strictEqual(deleteCalls[0], '/subscription/abc');
});
await checkAsync('gofa-subscribe-io: subscribe POST resolving 400 after close() does not start polling interval', async function() {
    var resolvePost;
    var postPromise = new Promise(function(resolve) { resolvePost = resolve; });
    var mockRobot = {
        requestRaw: function(method, p, body, opts) {
            if (method === 'POST' && p === '/subscription') {
                return postPromise;
            }
            return Promise.reject(new Error('unexpected requestRaw ' + method + ' ' + p));
        },
        getCookie: function() { return Promise.resolve('cookie=abc'); }
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-io', { nodesById: { r1: mockRobot } }))({ robot: 'r1', signal: 'Asi1Button1' });
    
    runInput(node, {});
    node._handlers['close'](function() {});
    resolvePost({ statusCode: 400 });
    
    try {
        await flush();
        assert.strictEqual(node._pollTimer, null, 'polling interval should not be created');
    } finally {
        if (node._pollTimer) {
            clearInterval(node._pollTimer);
        }
    }
});
await checkAsync('gofa-subscribe-state: subscribes via robot.requestRaw (not private robot internals), reports error on HTTP 400', async function() {
    var calls = [];
    var mockRobot = {
        requestRaw: function(method, p, body, opts) {
            calls.push({ method: method, path: p, body: body });
            return Promise.resolve({ statusCode: 400, headers: {}, body: Buffer.from('') });
        },
        getCookie: function() { return Promise.resolve('cookie=abc'); }
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-state', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    await flush();
    assert.ok(calls.some(function(c) { return c.method === 'POST' && c.path === '/subscription'; }));
    assert.ok(node.errors.length > 0, 'must report the subscribe failure');
});
await checkAsync('gofa-subscribe-state: subscribe POST resolves after close() does not create WS and deletes orphaned subscription', async function() {
    var deleteCalls = [];
    var resolvePost;
    var postPromise = new Promise(function(resolve) { resolvePost = resolve; });
    var mockRobot = {
        requestRaw: function(method, p, body, opts) {
            if (method === 'POST' && p === '/subscription') {
                return postPromise;
            }
            if (method === 'DELETE' && p.startsWith('/subscription/')) {
                deleteCalls.push(p);
                return Promise.resolve({ statusCode: 200, headers: {}, body: Buffer.from('') });
            }
            return Promise.reject(new Error('unexpected requestRaw ' + method + ' ' + p));
        },
        getCookie: function() { return Promise.resolve('cookie=abc'); }
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-state', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    
    runInput(node, {});
    node._handlers['close'](function() {});
    resolvePost({ statusCode: 201, headers: { location: 'http://localhost/poll/abc' } });
    await flush();
    
    assert.strictEqual(node._ws, null, 'WS should not have been created');
    assert.strictEqual(deleteCalls.length, 1, 'orphaned subscription should be deleted');
    assert.strictEqual(deleteCalls[0], '/subscription/abc');
});

// ── nodes/lib/ws.js (SimpleWS) ───────────────────────────────────────────────
// Hand-crafts a real WebSocket upgrade response over a plain net server (no `ws`
// package involved) so these tests exercise the real handshake/frame parser, not a
// mock. Frame bytes are built by hand per RFC 6455 §5.2.
var crypto = require('crypto');
var net    = require('net');
var SimpleWS = require('./nodes/lib/ws');

function wsFrame(opcode, fin, payload) {
    payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    var len = payload.length;
    var header;
    if (len < 126) {
        header = Buffer.from([(fin ? 0x80 : 0) | opcode, len]);
    } else {
        header = Buffer.alloc(4);
        header[0] = (fin ? 0x80 : 0) | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    }
    return Buffer.concat([header, payload]);
}

// Starts a raw TCP server that performs the WS opening handshake by hand, then lets
// the caller push arbitrary raw bytes (frames) at will — including bytes sent in the
// SAME write as the handshake response, to exercise the 'upgrade' event's `head`
// parameter (any bytes Node's HTTP parser already read off the socket before the
// 'upgrade' event fires never appear in a later 'data' event).
function startFakeWsServer(onSocket) {
    return new Promise(function(resolve) {
        var server = net.createServer(function(socket) {
            var buf = '';
            socket.on('data', function(chunk) {
                buf += chunk.toString('latin1');
                var m = /Sec-WebSocket-Key: (.+)\r\n/.exec(buf);
                if (!m || buf.indexOf('\r\n\r\n') === -1) return;
                var accept = crypto.createHash('sha1')
                    .update(m[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
                    .digest('base64');
                socket.write(
                    'HTTP/1.1 101 Switching Protocols\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
                );
                onSocket(socket);
            });
        });
        server.listen(0, function() { resolve({ server: server, port: server.address().port }); });
    });
}

await checkAsync('SimpleWS: basic handshake + single unfragmented text message', async function() {
    var fake = await startFakeWsServer(function(socket) {
        socket.write(wsFrame(0x1, true, 'hello world'));
    });
    var client = new SimpleWS('ws://127.0.0.1:' + fake.port + '/');
    var message = await new Promise(function(resolve, reject) {
        client.on('message', resolve);
        client.on('error', reject);
        setTimeout(function() { reject(new Error('timeout')); }, 2000);
    });
    assert.strictEqual(message, 'hello world');
    fake.server.close();
});

await checkAsync('SimpleWS: frame bytes bundled with the handshake response (head) are not dropped', async function() {
    // Writes the 101 response and the WS frame in the SAME socket.write() call, the
    // exact scenario that surfaces Node's 'upgrade' event `head` parameter — a real,
    // not-rare occurrence whenever a server pushes promptly after accepting the upgrade.
    var fake = await new Promise(function(resolve) {
        var server = net.createServer(function(socket) {
            var buf = '';
            socket.on('data', function(chunk) {
                buf += chunk.toString('latin1');
                var m = /Sec-WebSocket-Key: (.+)\r\n/.exec(buf);
                if (!m || buf.indexOf('\r\n\r\n') === -1) return;
                var accept = crypto.createHash('sha1')
                    .update(m[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
                    .digest('base64');
                var headers = Buffer.from(
                    'HTTP/1.1 101 Switching Protocols\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
                );
                socket.write(Buffer.concat([headers, wsFrame(0x1, true, 'bundled')]));
            });
        });
        server.listen(0, function() { resolve({ server: server, port: server.address().port }); });
    });
    var client = new SimpleWS('ws://127.0.0.1:' + fake.port + '/');
    var message = await new Promise(function(resolve, reject) {
        client.on('message', resolve);
        client.on('error', reject);
        setTimeout(function() { reject(new Error('timeout — bundled frame was dropped')); }, 2000);
    });
    assert.strictEqual(message, 'bundled');
    fake.server.close();
});

await checkAsync('SimpleWS: reassembles a fragmented message (FIN=0 then continuation FIN=1)', async function() {
    var fake = await startFakeWsServer(function(socket) {
        socket.write(wsFrame(0x1, false, 'FRAG-'));
        setTimeout(function() { socket.write(wsFrame(0x0, true, 'MENTED')); }, 20);
    });
    var client = new SimpleWS('ws://127.0.0.1:' + fake.port + '/');
    var messages = [];
    client.on('message', function(m) { messages.push(m); });
    await new Promise(function(resolve) { setTimeout(resolve, 300); });
    assert.deepStrictEqual(messages, ['FRAG-MENTED'], 'should emit exactly one reassembled message, not two fragments');
    fake.server.close();
});

await checkAsync('SimpleWS: server rejecting the upgrade with a plain HTTP response emits an error, not a hang', async function() {
    var server = http.createServer(function(req, res) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    });
    await new Promise(function(resolve) { server.listen(0, resolve); });
    var port = server.address().port;
    var client = new SimpleWS('ws://127.0.0.1:' + port + '/subscribe/bad');
    var err = await new Promise(function(resolve, reject) {
        client.on('open', function() { reject(new Error('should not have opened')); });
        client.on('error', resolve);
        setTimeout(function() { reject(new Error('timeout — rejected upgrade should error, not hang')); }, 2000);
    });
    assert.ok(/404/.test(err.message), 'error should mention the rejecting status code: ' + err.message);
    server.close();
});


// gofa-subscribe-elog ────────────────────────────────────────────────────────
// The subscribable resource is confirmed live to be the BARE path
// "/rw/elog/<domain>" — no ";suffix" at all, unlike ctrl-state (";ctrlstate")
// or I/O signals (";state"). Every ";elog"/";state"/";lvalue"/";log" guess
// returned 400 "Invalid resource URI" live; only the bare path returned 201.
// This test locks that in so a future "helpful" refactor doesn't reintroduce
// a guessed suffix.

await checkAsync('gofa-subscribe-elog: subscribes to the bare /rw/elog/<domain> resource (no ;suffix)', async function() {
    // Uses a 400 response (never reaching the real `new WS(...)` call) to match
    // how gofa-subscribe-io/gofa-subscribe-state tests avoid opening a real
    // WebSocket to a fake, unreachable subscription location.
    var calls = [];
    var mockRobot = {
        requestRaw: function(method, p, body, opts) {
            calls.push({ method: method, path: p, body: body });
            return Promise.resolve({ statusCode: 400, headers: {}, body: Buffer.from('') });
        },
        getCookie: function() { return Promise.resolve('cookie=abc'); }
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-elog', { nodesById: { r1: mockRobot } }))({ robot: 'r1', domain: '1' });
    var msg = {};
    await runInput(node, msg);
    await flush();
    var sub = calls.filter(function(c) { return c.method === 'POST' && c.path === '/subscription'; })[0];
    assert.ok(sub, 'must POST /subscription');
    assert.ok(sub.body.indexOf(encodeURIComponent('/rw/elog/1')) >= 0, 'must subscribe to bare /rw/elog/1');
    assert.ok(sub.body.indexOf(';') < 0, 'must not use a guessed ;suffix on the resource path');
});
await checkAsync('gofa-subscribe-elog: reports error on subscribe failure (HTTP 400)', async function() {
    var mockRobot = {
        requestRaw: function() { return Promise.resolve({ statusCode: 400, headers: {}, body: Buffer.from('') }); },
        getCookie: function() { return Promise.resolve('cookie=abc'); }
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-elog', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    await runInput(node, {});
    await flush();
    assert.ok(node.errors.length > 0, 'must report the subscribe failure');
});
await checkAsync('gofa-subscribe-elog: subscribe POST resolves after close() does not create WS and deletes orphaned subscription', async function() {
    var deleteCalls = [];
    var resolvePost;
    var postPromise = new Promise(function(resolve) { resolvePost = resolve; });
    var mockRobot = {
        requestRaw: function(method, p, body, opts) {
            if (method === 'POST' && p === '/subscription') {
                return postPromise;
            }
            if (method === 'DELETE' && p.startsWith('/subscription/')) {
                deleteCalls.push(p);
                return Promise.resolve({ statusCode: 200, headers: {}, body: Buffer.from('') });
            }
            return Promise.reject(new Error('unexpected requestRaw ' + method + ' ' + p));
        },
        getCookie: function() { return Promise.resolve('cookie=abc'); }
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-elog', { nodesById: { r1: mockRobot } }))({ robot: 'r1', domain: '1' });
    
    runInput(node, {});
    node._handlers['close'](function() {});
    resolvePost({ statusCode: 201, headers: { location: 'http://localhost/poll/abc' } });
    await flush();
    
    assert.strictEqual(node._ws, null, 'WS should not have been created');
    assert.strictEqual(deleteCalls.length, 1, 'orphaned subscription should be deleted');
    assert.strictEqual(deleteCalls[0], '/subscription/abc');
});
await checkAsync('gofa-subscribe-elog: fetchAndEmit resolves after close() does not send message', async function() {
    var origWs = require.cache[require.resolve('./nodes/lib/ws')];
    var EventEmitter = require('events');
    function MockWS(url, protocols, options) {
        EventEmitter.call(this);
        MockWS.lastInstance = this;
    }
    require('util').inherits(MockWS, EventEmitter);
    MockWS.prototype.terminate = function() {};
    require.cache[require.resolve('./nodes/lib/ws')] = { exports: MockWS };
    delete require.cache[require.resolve('./nodes/gofa-subscribe-elog')];

    var resolveGet;
    var getPromise = new Promise(function(resolve) { resolveGet = resolve; });
    var mockRobot = {
        requestRaw: function(method, p, body, opts) {
            return Promise.resolve({ statusCode: 201, headers: { location: '/poll/abc' } });
        },
        getCookie: function() { return Promise.resolve('cookie=abc'); },
        rwsGet: function(href) {
            return getPromise;
        }
    };
    var GoFaSubscribeElog = loadNodeType('./nodes/gofa-subscribe-elog', { nodesById: { r1: mockRobot } });

    var node = new GoFaSubscribeElog({ robot: 'r1', domain: '1', minSeverity: 1 });

    runInput(node, {});
    await new Promise(function(resolve) { setTimeout(resolve, 150); });
    await flush();

    var wsInstance = MockWS.lastInstance;
    assert.ok(wsInstance);
    wsInstance.emit('open');

    var msgBody = '<li class="elog-message-ev"><a href="/rw/elog/1/123" rel="self"></a></li>';
    wsInstance.emit('message', Buffer.from(msgBody));

    node._handlers['close'](function() {});

    var elogXhtml = '<li class="elog-message"><span class="seqnum">123</span><span class="msgtype">1</span><span class="code">1001</span><span class="title">Test</span><span class="tstamp">time</span></li>';
    resolveGet(elogXhtml);
    await flush();

    assert.strictEqual(node.sent.length, 0, 'no message should be sent from closed node');

    require.cache[require.resolve('./nodes/lib/ws')] = origWs;
    delete require.cache[require.resolve('./nodes/gofa-subscribe-elog')];
});
check('gofa-subscribe-elog: parseEntry reads fields from both the list-item and single-entry XHTML shapes', function() {
    var parseEntry = require('./nodes/gofa-subscribe-elog').parseEntry;
    var listShape = '<li class="elog-message-li" title="/rw/elog/1/17352"><span class="seqnum">17352</span><span class="msgtype">1</span><span class="code">10400</span><span class="title">User logged on</span><span class="tstamp">2026-07-10 T 10:54:46</span></li>';
    var singleShape = '<li class="elog-message" title="/rw/elog/1/17352"><span class="seqnum">17352</span><span class="msgtype">1</span><span class="code">10400</span><span class="title">User logged on</span><span class="tstamp">2026-07-10 T 10:54:46</span></li>';
    [listShape, singleShape].forEach(function(shape) {
        var entry = parseEntry(shape);
        assert.strictEqual(entry.seqnum, '17352');
        assert.strictEqual(entry.code, '10400');
        assert.strictEqual(entry.title, 'User logged on');
    });
});
check('gofa-subscribe-elog: meetsSeverity gates on msgtype vs. the configured threshold (the actual logic fetchAndEmit uses before emitting)', function() {
    var mod = require('./nodes/gofa-subscribe-elog');
    var info  = mod.parseEntry('<li class="elog-message"><span class="msgtype">1</span></li>');
    var warn  = mod.parseEntry('<li class="elog-message"><span class="msgtype">2</span></li>');
    var error = mod.parseEntry('<li class="elog-message"><span class="msgtype">3</span></li>');
    assert.strictEqual(mod.meetsSeverity(info, 3), false, '"error only" must drop an info entry');
    assert.strictEqual(mod.meetsSeverity(warn, 3), false, '"error only" must drop a warning entry');
    assert.strictEqual(mod.meetsSeverity(error, 3), true, '"error only" must keep an error entry');
    assert.strictEqual(mod.meetsSeverity(info, 1), true, 'default threshold (1) must keep everything');
    assert.strictEqual(mod.meetsSeverity(null, 1), false, 'a failed parseEntry (null) must never be emitted');
});

// gofa-elog ──────────────────────────────────────────────────────────────────

await checkAsync('gofa-elog: minSeverity filters out entries below the threshold', async function() {
    var body = '<li class="elog-message-li"><span class="seqnum">1</span><span class="msgtype">1</span><span class="code">10010</span><span class="title">Motors Off state</span><span class="tstamp">t</span></li>' +
               '<li class="elog-message-li"><span class="seqnum">2</span><span class="msgtype">2</span><span class="code">20000</span><span class="title">Some warning</span><span class="tstamp">t</span></li>' +
               '<li class="elog-message-li"><span class="seqnum">3</span><span class="msgtype">3</span><span class="code">99999</span><span class="title">Some error</span><span class="tstamp">t</span></li>';
    var mockRobot = { rwsGet: function() { return Promise.resolve(body); } };
    var node = new (loadNodeType('./nodes/gofa-elog', { nodesById: { r1: mockRobot } }))({ robot: 'r1', domain: '1', count: 10, minSeverity: '2' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.entries.length, 2, 'must drop the msgtype=1 entry, keep warning+error');
    assert.ok(msg.payload.entries.every(function(e) { return parseInt(e.msgtype) >= 2; }));
});
await checkAsync('gofa-elog: default minSeverity (1) keeps every entry', async function() {
    var body = '<li class="elog-message-li"><span class="seqnum">1</span><span class="msgtype">1</span><span class="code">10010</span><span class="title">Motors Off state</span><span class="tstamp">t</span></li>';
    var mockRobot = { rwsGet: function() { return Promise.resolve(body); } };
    var node = new (loadNodeType('./nodes/gofa-elog', { nodesById: { r1: mockRobot } }))({ robot: 'r1', domain: '1', count: 10 });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.entries.length, 1);
});

// gofa-do-write ──────────────────────────────────────────────────────────────

await checkAsync('gofa-do-write: RWS transport (default) posts /set-value, unchanged from before the Socket transport was added', async function() {
    var calls = [];
    var mockRobot = { rwsPost: function(p, body) { calls.push({ path: p, body: body }); return Promise.resolve(); } };
    var node = new (loadNodeType('./nodes/gofa-do-write', { nodesById: { r1: mockRobot } }))({ robot: 'r1', signal: 'ABB_Scalable_IO_0_DO1', value: 1 });
    var msg = { payload: 1 };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.transport, 'rws');
    assert.strictEqual(calls[0].path, '/rw/iosystem/signals/ABB_Scalable_IO_0_DO1/set-value');
    assert.strictEqual(calls[0].body, 'lvalue=1');
});
await checkAsync('gofa-do-write: Socket transport upper-cases the signal name (RAPID DispatchJson matches case-sensitively, unlike the legacy text protocol)', async function() {
    var calls = [];
    var mockRobot = { socketSend: function(cmd) { calls.push(cmd); return Promise.resolve('OK:SETDO'); } };
    var node = new (loadNodeType('./nodes/gofa-do-write', { nodesById: { r1: mockRobot } }))({ robot: 'r1', signal: 'ABB_Scalable_IO_0_DO1', value: 1, transport: 'socket' });
    var msg = { payload: 1 };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.transport, 'socket');
    assert.deepStrictEqual(calls[0], { cmd: 'setdo', name: 'ABB_SCALABLE_IO_0_DO1', val: 1 });
});
await checkAsync('gofa-do-write: Socket transport surfaces an ERR:SETDO reply (e.g. unknown signal) as a failure', async function() {
    var mockRobot = { socketSend: function() { return Promise.resolve('ERR:SETDO'); } };
    var node = new (loadNodeType('./nodes/gofa-do-write', { nodesById: { r1: mockRobot } }))({ robot: 'r1', signal: 'ABB_Scalable_IO_0_DO1', value: 1, transport: 'socket' });
    var msg = { payload: 1 };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
});
await checkAsync('gofa-do-write: msg.payload.transport overrides the configured transport at runtime', async function() {
    var socketCalled = false, rwsCalled = false;
    var mockRobot = {
        socketSend: function() { socketCalled = true; return Promise.resolve('OK:SETDO'); },
        rwsPost: function() { rwsCalled = true; return Promise.resolve(); }
    };
    var node = new (loadNodeType('./nodes/gofa-do-write', { nodesById: { r1: mockRobot } }))({ robot: 'r1', signal: 'ABB_Scalable_IO_0_DO1', value: 1, transport: 'rws' });
    var msg = { payload: { value: 1, transport: 'socket' } };
    await runInput(node, msg);
    assert.strictEqual(socketCalled, true);
    assert.strictEqual(rwsCalled, false);
});

// gofa-subscribe-var ─────────────────────────────────────────────────────────

await checkAsync('gofa-subscribe-var: reads via module-text only, never attempts the dead RWS symbol path', async function() {
    var calls = [];
    var mockRobot = {
        rwsGet: function(p) {
            calls.push(p);
            if (p === '/rw/rapid/tasks/T_ROB1/modules/MainModule/text') {
                return Promise.resolve('<span class="file-path">TEMP/MainModule.mod</span>');
            }
            if (p === '/fileservice/TEMP/MainModule.mod') {
                return Promise.resolve('PERS num nTestVar := 7;');
            }
            return Promise.reject(new Error('unexpected GET ' + p));
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-var', { nodesById: { r1: mockRobot } }))(
        { robot: 'r1', task: 'T_ROB1', module: 'MainModule', variable: 'nTestVar', interval: '100000', outputPayload: true });
    await runInput(node, {}); // toggle on -> first poll fires immediately
    await flush();
    node._polling = false; if (node._timer) clearTimeout(node._timer); // stop before the next tick fires

    assert.ok(!calls.some(function(p) { return p.indexOf('/rw/rapid/symbol/data/') >= 0; }), 'must not attempt the dead RWS symbol endpoint');
    assert.strictEqual(node.sent.length, 1);
    assert.strictEqual(node.sent[0].payload.value, '7');
    assert.strictEqual(node.sent[0].payload.source, 'module-text');
    assert.strictEqual(node.sent[0].payload.stale, true, 'module-text reads must be flagged stale — confirmed live to return the compiled value, not the current one');
});
await checkAsync('gofa-subscribe-var: toggles off on the second input without sending another message', async function() {
    var mockRobot = {
        rwsGet: function(p) {
            if (p.indexOf('/text') >= 0) return Promise.resolve('<span class="file-path">TEMP/MainModule.mod</span>');
            return Promise.resolve('PERS num nTestVar := 1;');
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-var', { nodesById: { r1: mockRobot } }))(
        { robot: 'r1', task: 'T_ROB1', module: 'MainModule', variable: 'nTestVar', interval: '100000' });
    await runInput(node, {});
    await flush();
    assert.strictEqual(node.sent.length, 1);
    await runInput(node, {}); // toggle off
    assert.strictEqual(node._polling, false);
    await flush();
    assert.strictEqual(node.sent.length, 1, 'no further message after stopping');
});
await checkAsync('gofa-subscribe-var: reports an error status when the variable is not found', async function() {
    var mockRobot = {
        rwsGet: function(p) {
            if (p.indexOf('/text') >= 0) return Promise.resolve('<span class="file-path">TEMP/MainModule.mod</span>');
            return Promise.resolve('PERS num somethingElse := 1;');
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-var', { nodesById: { r1: mockRobot } }))(
        { robot: 'r1', task: 'T_ROB1', module: 'MainModule', variable: 'nTestVar', interval: '100000' });
    await runInput(node, {});
    await flush();
    node._polling = false; if (node._timer) clearTimeout(node._timer);
    assert.strictEqual(node.sent.length, 0);
    assert.ok(node.errors.some(function(e) { return e.indexOf('not found') >= 0; }));
});

// gofa-rapid-var-write ───────────────────────────────────────────────────────
await checkAsync('gofa-rapid-var-write: succeeds on OK:SETVAR', async function() {
    var mockRobot = { socketSend: function(cmd) { return Promise.resolve('OK:SETVAR'); } };
    var node = new (loadNodeType('./nodes/gofa-rapid-var-write', { nodesById: { r1: mockRobot } }))({ robot: 'r1', variable: 'nTestVar', value: '5' });
    var msg = {};
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload, { ok: true, variable: 'nTestVar', value: '5' });
});
await checkAsync('gofa-rapid-var-write: a generic ERR:SETVAR reply gets one combined hint, not a dead unreachable-branch check', async function() {
    // socketSend()'s JSON reply translator collapses every RAPID-side reason into
    // a bare 'ERR:SETVAR' — the old checks for 'ERR:UNKNOWN_VAR'/'ERR:PARSE' could
    // never match that and were dead code. This just confirms a single honest
    // combined hint is produced instead, regardless of what actually went wrong.
    var mockRobot = { socketSend: function() { return Promise.resolve('ERR:SETVAR'); } };
    var node = new (loadNodeType('./nodes/gofa-rapid-var-write', { nodesById: { r1: mockRobot } }))({ robot: 'r1', variable: 'nTestVar', value: '5' });
    var msg = {};
    var err = await runInput(node, msg);
    assert.ok(err);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(/TryGetVar\/TrySetVar/.test(msg.payload.error));
    assert.ok(/valid value for its RAPID type/.test(msg.payload.error));
});

// gofa-rapid-var-read ────────────────────────────────────────────────────────
await checkAsync('gofa-rapid-var-read: uses the live socket value when the variable is known to GETVAR', async function() {
    var mockRobot = { socketSend: function(cmd) { return Promise.resolve('VAL:9.000000'); } };
    var node = new (loadNodeType('./nodes/gofa-rapid-var-read', { nodesById: { r1: mockRobot } }))({ robot: 'r1', variable: 'nTestVar' });
    var msg = {};
    await runInput(node, msg);
    assert.deepStrictEqual(msg.payload, { ok: true, variable: 'nTestVar', value: 9, source: 'socket' });
});
await checkAsync('gofa-rapid-var-read: falls back to module-text when GETVAR doesn\'t know the variable, flagged stale', async function() {
    var mockRobot = {
        socketSend: function() { return Promise.resolve('ERR:UNKNOWN_VAR'); },
        rwsGet: function(p) {
            if (p.indexOf('/text') >= 0) return Promise.resolve('<span class="file-path">TEMP/MainModule.mod</span>');
            return Promise.resolve('PERS num nOther := 42;');
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-rapid-var-read', { nodesById: { r1: mockRobot } }))({ robot: 'r1', variable: 'nOther' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.value, '42');
    assert.strictEqual(msg.payload.source, 'module-text');
    assert.strictEqual(msg.payload.stale, true, 'module-text reads must be flagged stale — confirmed live to return the compiled value, not the current one');
    assert.ok(msg.payload.warning, 'should explain why the value may not be current');
});

// gofa-robot: createRobotClient session lifecycle (login/logout) ───────────
// A local mock RWS server standing in for the controller: any request with
// no Cookie header is treated as the Basic-Auth login (issues a fresh
// Set-Cookie), GET /logout is recorded separately, everything else with a
// Cookie header is just a plain authenticated 200.
function makeMockRwsServer() {
    var loginCount = 0, logoutCookies = [], cookieSeq = 0;
    var server = http.createServer(function(req, res) {
        if (req.url === '/logout') {
            logoutCookies.push(req.headers['cookie'] || null);
            res.writeHead(200); res.end(); return;
        }
        if (!req.headers['cookie']) {
            loginCount++; cookieSeq++;
            res.writeHead(200, { 'Set-Cookie': 'ABBCX=sess' + cookieSeq });
            res.end('<html></html>'); return;
        }
        res.writeHead(200); res.end('<html></html>');
    });
    return {
        server: server,
        loginCount: function() { return loginCount; },
        logoutCookies: function() { return logoutCookies; },
        listen: function() { return new Promise(function(resolve) { server.listen(0, function() { resolve(server.address().port); }); }); }
    };
}
await checkAsync('createRobotClient: logout releases the session and the next call re-authenticates', async function() {
    var mock = makeMockRwsServer();
    var port = await mock.listen();
    try {
        var client = createRobotClient({ ip: '127.0.0.1', rwsPort: port, socketPort: 1025, username: 'u', password: 'p' });

        var firstCookie = await client.getCookie();
        assert.strictEqual(mock.loginCount(), 1, 'first use must log in exactly once');
        assert.ok(firstCookie, 'a session cookie should be captured');

        await client.rwsGet('/rw/panel/ctrl-state');
        assert.strictEqual(mock.loginCount(), 1, 'reusing the session must not re-authenticate');

        await client.logout();
        assert.strictEqual(mock.logoutCookies().length, 1, 'logout must hit GET /logout exactly once');
        assert.strictEqual(mock.logoutCookies()[0], firstCookie, 'logout must send the session cookie being released');

        var secondCookie = await client.getCookie();
        assert.strictEqual(mock.loginCount(), 2, 'the next call after logout must re-authenticate');
        assert.notStrictEqual(secondCookie, firstCookie, 'a fresh session should replace the released one');
    } finally { mock.server.close(); }
});
await checkAsync('createRobotClient: requestRaw retries once with forced Basic-auth on a stale 401 instead of hard-failing', async function() {
    // Simulates a session that expired server-side since it was last used: any
    // Cookie-based request gets 401, but Basic-auth still works. Before this fix,
    // requestRaw had no retry at all (unlike rwsGet/rwsPost) and would hard-fail
    // with a bare "HTTP 401 Unauthorized" here instead of transparently
    // re-authenticating the way every other RWS call in this palette does.
    var basicAuthHits = 0;
    var server = http.createServer(function(req, res) {
        if (req.headers.authorization && req.headers.authorization.indexOf('Basic') === 0) {
            basicAuthHits++;
            res.writeHead(200, { 'Set-Cookie': 'ABBCX=fresh' });
            res.end('ok');
        } else {
            res.writeHead(401);
            res.end();
        }
    });
    var port = await new Promise(function(resolve) { server.listen(0, function() { resolve(server.address().port); }); });
    try {
        var client = createRobotClient({ ip: '127.0.0.1', rwsPort: port, socketPort: 1025, username: 'u', password: 'p' });
        await client.getCookie(); // establishes a (soon-to-be-stale) cookie via Basic auth
        var res = await client.requestRaw('GET', '/rw/some/resource', null, {});
        assert.strictEqual(res.statusCode, 200, 'must recover via forced Basic-auth retry, not hard-fail on the stale-cookie 401');
        assert.ok(basicAuthHits >= 2, 'expected the initial login plus at least one forced-auth retry');
    } finally { server.close(); }
});
await checkAsync('createRobotClient: logout is a no-op when no session was ever established', async function() {
    var hit = false;
    var server = http.createServer(function(req, res) { hit = true; res.writeHead(200); res.end(); });
    await new Promise(function(resolve) { server.listen(0, resolve); });
    try {
        var client = createRobotClient({ ip: '127.0.0.1', rwsPort: server.address().port, socketPort: 1025, username: 'u', password: 'p' });
        await client.logout();
        assert.strictEqual(hit, false, 'logout must not make any HTTP request if no session cookie exists');
    } finally { server.close(); }
});
await checkAsync('gofa-robot: node close calls logout and invokes done()', async function() {
    var mock = makeMockRwsServer();
    var port = await mock.listen();
    try {
        var GoFaRobot = loadNodeType('./nodes/gofa-robot', {});
        var node = new GoFaRobot({
            ip: '127.0.0.1', rwsPort: port, socketPort: 1025, username: 'u',
            pointsFile: path.join(tmpDir, 'gofa-robot-close-test.json'),
            credentials: { password: 'p' }
        });
        await node.rwsGet('/rw/panel/ctrl-state');
        assert.strictEqual(mock.loginCount(), 1, 'establishing a session should log in once');

        var doneCalled = false;
        await new Promise(function(resolve) {
            node._handlers['close'](function() { doneCalled = true; resolve(); });
        });
        assert.strictEqual(doneCalled, true, 'close handler must call done()');
        assert.strictEqual(mock.logoutCookies().length, 1, 'close must log out the session via GET /logout');
    } finally { mock.server.close(); }
});

// gofa-egm ───────────────────────────────────────────────────────────────────
// Session state (_egmActive/_egmTarget/_egmBaseline) lives on the shared
// gofa-robot config node now, not the gofa-egm node instance -- same
// cross-node pattern as _seqStop/_seqRunning (gofa-sequencer/gofa-stop-seq).
// gofa-egm-move (tested further below) is the node that writes _egmTarget.
await checkAsync('gofa-egm: no robot configured reports an error and does not hang', async function() {
    var node = new (loadNodeType('./nodes/gofa-egm', {}))({ udpPort: 0, throttleMs: 100 });
    var err = await runInput(node, { payload: 'start' });
    assert.ok(err, 'done(err) should be called');
    assert.ok(node.errors.some(function(e) { return /no robot configured/i.test(e); }));
});
await checkAsync('gofa-egm: "start" gets ERR:EGMJOINT -> friendly wrong-module error, no UDP bind attempted', async function() {
    var mockRobot = { _egmActive: false, socketSend: function(cmd) { assert.deepStrictEqual(cmd, { cmd: 'egmjoint' }); return Promise.resolve('ERR:EGMJOINT'); } };
    var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', udpPort: 0, throttleMs: 100 });
    var err = await runInput(node, { payload: 'start' });
    assert.ok(err);
    assert.ok(node.errors.some(function(e) { return /MainModuleEGM\.mod/.test(e); }),
        'error should point at loading MainModuleEGM.mod');
    assert.strictEqual(mockRobot._egmActive, false);
    assert.ok(!mockRobot._egmSocket, 'no UDP socket should have been created');
});
await checkAsync('gofa-egm: an unexpected socket reply on start is surfaced as an error', async function() {
    var mockRobot = { _egmActive: false, socketSend: function() { return Promise.resolve('ERR:UNKNOWN'); } };
    var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', udpPort: 0, throttleMs: 100 });
    var err = await runInput(node, { payload: 'start' });
    assert.ok(err);
    assert.strictEqual(mockRobot._egmActive, false);
});
await checkAsync('gofa-egm: a bare inject (no start/stop payload) runs the node\'s configured Action', async function() {
    var calls = [];
    var mockRobot = {
        rwsPost: function(p, b) { calls.push([p, b]); return Promise.resolve(''); },
        socketSend: function(cmd) { calls.push(['socketSend', cmd]); return Promise.resolve('OK:PING'); }
    };
    var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'stop', udpPort: 0, throttleMs: 100 });
    var err = await runInput(node, { payload: Date.now() }); // a date-inject payload: not a string, no .action
    assert.strictEqual(err, undefined);
    assert.deepStrictEqual(calls[0], ['/rw/iosystem/signals/ABB_Scalable_IO_0_DO16/set-value', 'lvalue=1']);
});
await checkAsync('gofa-egm: an unrecognized msg.payload.action is rejected with a clear hint', async function() {
    var mockRobot = {};
    var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', udpPort: 0, throttleMs: 100 });
    await runInput(node, { payload: { action: 'bogus' } });
    assert.ok(node.errors.some(function(e) { return /action must be "start" or "stop"/.test(e); }));
});
// "stop" sets a dedicated RWS-writable DO signal (watched by an ISignalDO
// TRAP in MainModuleEGM.mod that calls EGMStop) instead of issuing an RWS
// task-level stop -- confirmed live (2026-07-09) that a task-level stop
// skips RunEgmJoint's own cleanup and leaks a controller-side EGM instance
// every cycle (RobotWare allows max 4 concurrent EGM identities, per ABB's
// EGM Application Manual 3HAC073318), eventually erroring "Too many EGM
// instances". EGMStop from a TRAP lets EGMRunJoint return normally instead,
// so cleanup always runs and the task never actually stops.
await checkAsync('gofa-egm: "stop" sets the graceful-stop signal via RWS and waits for TCP to resume', async function() {
    var calls = [];
    var mockRobot = {
        rwsPost: function(p, b) { calls.push([p, b]); return Promise.resolve(''); },
        socketSend: function(cmd) { calls.push(['socketSend', cmd]); return Promise.resolve('OK:PING'); }
    };
    var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', udpPort: 0, throttleMs: 100 });
    var err = await runInput(node, { payload: 'stop' });
    assert.strictEqual(err, undefined);
    assert.strictEqual(node.statuses[node.statuses.length - 1].text, 'stopped');
    assert.deepStrictEqual(calls[0], ['/rw/iosystem/signals/ABB_Scalable_IO_0_DO16/set-value', 'lvalue=1']);
    assert.deepStrictEqual(calls[1], ['socketSend', { cmd: 'ping' }]);
    assert.strictEqual(mockRobot._egmActive, false);
    assert.strictEqual(mockRobot._egmTarget, null);
});
await checkAsync('gofa-egm: "stop" retries PING until TCP mode actually resumes (not just after the signal write)', async function() {
    var pingAttempts = 0;
    var mockRobot = {
        rwsPost: function() { return Promise.resolve(''); },
        socketSend: function() {
            pingAttempts++;
            if (pingAttempts < 3) return Promise.reject(new Error('connection refused'));
            return Promise.resolve('OK:PING');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', udpPort: 0, throttleMs: 100 });
    var err = await runInput(node, { payload: 'stop' });
    assert.strictEqual(err, undefined);
    assert.strictEqual(pingAttempts, 3, 'must keep retrying PING, not just fire-and-forget the signal write');
});
await checkAsync('gofa-egm: node close() sets the graceful-stop signal when a session was active, and calls done()', async function() {
    var calls = [];
    var mockRobot = {
        _egmActive: true,
        rwsPost: function(p) { calls.push(p); return Promise.resolve(''); },
        socketSend: function() { return Promise.resolve('OK:PING'); }
    };
    var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', udpPort: 0, throttleMs: 100 });
    var fakeSocket = { closed: false, close: function() { this.closed = true; } };
    mockRobot._egmSocket = fakeSocket;
    var doneCalled = false;
    await new Promise(function(resolve) {
        node._handlers['close'](function() { doneCalled = true; resolve(); });
    });
    assert.strictEqual(doneCalled, true);
    assert.strictEqual(fakeSocket.closed, true);
    assert.strictEqual(mockRobot._egmActive, false);
    assert.strictEqual(mockRobot._egmSocket, null, 'socket ref must be cleared, whichever instance created it');
    assert.strictEqual(node._stopped, true);
    assert.ok(calls.indexOf('/rw/iosystem/signals/ABB_Scalable_IO_0_DO16/set-value') >= 0,
        'close on an active session must set the graceful-stop signal');
});
await checkAsync('gofa-egm: node close() on a never-started node is a fast no-op (no RWS calls)', async function() {
    var mockRobot = { _egmActive: false, rwsPost: function() { throw new Error('must not be called'); } };
    var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', udpPort: 0, throttleMs: 100 });
    var doneCalled = false;
    await new Promise(function(resolve) {
        node._handlers['close'](function() { doneCalled = true; resolve(); });
    });
    assert.strictEqual(doneCalled, true);
    assert.strictEqual(node._stopped, true);
});
// Confirmed live (2026-07-09): splitting "Start EGM"/"Stop EGM" into two node
// instances (the documented pattern) leaked the UDP socket -- the Stop
// instance's stopAll() closed its OWN node._socket (never bound, always
// null), not the Start instance's real one, since the socket lived on the
// node instance instead of the shared robot object. Fixed by moving it onto
// robot._egmSocket, same as the other EGM state.
await checkAsync('gofa-egm: a DIFFERENT node instance can close the socket a Start instance opened', async function() {
    var mockRobot = { _egmActive: true, rwsPost: function() { return Promise.resolve(''); }, socketSend: function() { return Promise.resolve('OK:PING'); } };
    var fakeSocket = { closed: false, close: function() { this.closed = true; } };
    mockRobot._egmSocket = fakeSocket; // as if a separate "Start" instance opened it
    var stopNode = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'stop', udpPort: 0, throttleMs: 100 });
    var err = await runInput(stopNode, { payload: 'stop' });
    assert.strictEqual(err, undefined);
    assert.strictEqual(fakeSocket.closed, true, 'a Stop instance must close whichever socket is on the shared robot object');
    assert.strictEqual(mockRobot._egmSocket, null);
});
await checkAsync('gofa-egm: start() releases the orphaned controller-side session if EGMJOINT acked but the UDP bind fails', async function() {
    var dgram = require('dgram');
    var blocker = dgram.createSocket('udp4');
    await new Promise(function(resolve) { blocker.bind(0, resolve); });
    var port = blocker.address().port; // occupy it so gofa-egm's own bind() hits EADDRINUSE fast
    var calls = [];
    var mockRobot = {
        _egmActive: false,
        socketSend: function() { return Promise.resolve('OK:EGMJOINT'); },
        rwsPost: function(p, b) { calls.push([p, b]); return Promise.resolve(''); }
    };
    var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'start', udpPort: port, throttleMs: 100 });
    var err = await runInput(node, { payload: 'start' });
    blocker.close();
    assert.ok(err, 'bind failure must reject');
    assert.ok(calls.some(function(c) { return c[0] === '/rw/iosystem/signals/ABB_Scalable_IO_0_DO16/set-value'; }),
        'must release the controller-side EGM session that EGMJOINT already started, or it is orphaned with no natural recovery');
});

await checkAsync('gofa-egm: straggler UDP frame arriving after stop() does not re-populate _egmTarget or throw', async function() {
    var dgram = require('dgram');
    var originalCreateSocket = dgram.createSocket;
    var messageHandler = null;
    var mockSocket = {
        on: function(evt, fn) {
            if (evt === 'message') messageHandler = fn;
        },
        bind: function(port, cb) {
            if (cb) cb();
        },
        close: function() {
            this.closed = true;
        },
        send: function(buf, port, addr, cb) {
            this.sent = this.sent || [];
            this.sent.push(buf);
            if (cb) cb();
        }
    };

    dgram.createSocket = function(type) {
        return mockSocket;
    };

    try {
        var mockRobot = {
            _egmActive: false,
            _egmBaseline: null,
            _egmTarget: null,
            _egmSocket: null,
            socketSend: function(cmd) {
                if (cmd.cmd === 'egmjoint') return Promise.resolve('OK:EGMJOINT');
                if (cmd.cmd === 'ping') return Promise.resolve('OK:PING');
                return Promise.reject(new Error('unknown cmd'));
            },
            rwsPost: function() { return Promise.resolve(''); }
        };

        var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'start', udpPort: 12345, throttleMs: 100 });
        
        // Start EGM
        var startPromise = runInput(node, { payload: 'start' });
        
        // Wait a tick for the promise chain to call bindSocket()
        await new Promise(function(resolve) { setImmediate(resolve); });
        
        // Simulate EGM message arriving to settle the start
        assert.ok(messageHandler);
        var buf = Buffer.from(REF_ROBOT_HEX, 'hex');
        messageHandler(buf, { address: '127.0.0.1', port: 12345 });
        
        await startPromise;
        
        assert.strictEqual(mockRobot._egmActive, true);
        assert.ok(mockRobot._egmTarget);
        assert.ok(mockRobot._egmBaseline);
        assert.strictEqual(mockRobot._egmSocket, mockSocket);

        // Now stop EGM
        var stopNode = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'stop', udpPort: 12345, throttleMs: 100 });
        var stopPromise = runInput(stopNode, { payload: 'stop' });
        
        // At this point, stopAll() has run synchronously, setting target/baseline to null and closing the socket.
        assert.strictEqual(mockRobot._egmActive, false);
        assert.strictEqual(mockRobot._egmBaseline, null);
        assert.strictEqual(mockRobot._egmTarget, null);
        assert.strictEqual(mockRobot._egmSocket, null);

        // Simulate a straggler message arriving during the stop process
        messageHandler(buf, { address: '127.0.0.1', port: 12345 });

        // Target must remain null and no exception should be thrown
        assert.strictEqual(mockRobot._egmTarget, null, 'EGM target must remain null after stop');
        assert.strictEqual(mockRobot._egmBaseline, null, 'EGM baseline must remain null after stop');

        await stopPromise;
    } finally {
        dgram.createSocket = originalCreateSocket;
    }
});
await checkAsync('gofa-egm: bindSocket no-frame timer firing after close() does not error or call stopAll again', async function() {
    var dgram = require('dgram');
    var originalCreateSocket = dgram.createSocket;
    var originalSetTimeout = global.setTimeout;
    
    var timerCallback = null;
    global.setTimeout = function(cb, delay) {
        if (delay === 2000) {
            timerCallback = cb;
            return 123;
        }
        return originalSetTimeout(cb, delay);
    };
    
    var mockSocket = {
        bind: function(port, cb) { if (cb) cb(); },
        close: function() { this.closed = true; },
        on: function() {}
    };
    dgram.createSocket = function() { return mockSocket; };
    
    var mockRobot = {
        _egmActive: false,
        _egmSocket: null,
        socketSend: function(cmd) {
            if (cmd.cmd === 'egmjoint') return Promise.resolve('OK:EGMJOINT');
            if (cmd.cmd === 'ping') return Promise.resolve('OK:PING');
            return Promise.reject(new Error('unknown cmd'));
        },
        rwsPost: function() {
            return Promise.resolve('');
        }
    };
    
    try {
        var node = new (loadNodeType('./nodes/gofa-egm', { nodesById: { r1: mockRobot } }))({
            robot: 'r1', action: 'start', udpPort: 12345, throttleMs: 100
        });
        
        var startPromise = runInput(node, { payload: 'start' });
        await new Promise(function(resolve) { setImmediate(resolve); });
        
        assert.ok(timerCallback, '2s timer should be registered');
        node._handlers['close'](function() {});
        
        timerCallback();
        await new Promise(function(resolve) { setImmediate(resolve); });
        
        assert.strictEqual(node.errors.length, 0, 'should not log any errors');
        var hasErrorStatus = node.statuses.some(function(s) { return s.text === 'error'; });
        assert.strictEqual(hasErrorStatus, false, 'should not flip status to error');
    } finally {
        dgram.createSocket = originalCreateSocket;
        global.setTimeout = originalSetTimeout;
    }
});

// gofa-egm-move ──────────────────────────────────────────────────────────────
await checkAsync('gofa-egm-move: no robot configured reports an error and sends nothing', async function() {
    var node = new (loadNodeType('./nodes/gofa-egm-move', {}))({});
    await runInput(node, { payload: [1, 2, 3, 4, 5, 6] });
    assert.ok(node.errors.some(function(e) { return /no robot configured/i.test(e); }));
    assert.strictEqual(node.sent.length, 0);
});
await checkAsync('gofa-egm-move: a malformed joint array (wrong length) is rejected, no output either way', async function() {
    var mockRobot = { _egmActive: true, _egmTarget: null };
    var node = new (loadNodeType('./nodes/gofa-egm-move', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    await runInput(node, { payload: [1, 2, 3] });
    assert.ok(node.errors.some(function(e) { return /6-number joint array/.test(e); }));
    assert.strictEqual(node.sent.length, 0);
    assert.strictEqual(mockRobot._egmTarget, null);
});
await checkAsync('gofa-egm-move: an unrecognized payload shape is rejected with a clear hint', async function() {
    var mockRobot = { _egmActive: true, _egmTarget: null };
    var node = new (loadNodeType('./nodes/gofa-egm-move', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    await runInput(node, { payload: { bogus: true } });
    assert.ok(node.errors.some(function(e) { return /6-number joint array or \{joints:\[\.\.\.\]\}/.test(e); }));
});
await checkAsync('gofa-egm-move: EGM active -> target forwarded on output 1, robot._egmTarget updated', async function() {
    var mockRobot = { _egmActive: true, _egmTarget: null };
    var node = new (loadNodeType('./nodes/gofa-egm-move', { nodesById: { r1: mockRobot } }))({ robot: 'r1', outputPayload: true });
    var err = await runInput(node, { payload: [1, 2, 3, 4, 5, 6] });
    assert.strictEqual(err, undefined);
    assert.strictEqual(node.sent.length, 1);
    assert.deepStrictEqual(node.sent[0][0].payload, [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(node.sent[0][1], null);
    assert.deepStrictEqual(mockRobot._egmTarget, [1, 2, 3, 4, 5, 6]);
});
await checkAsync('gofa-egm-move: EGM not active -> routed to output 2 (fallback), not an error, robot._egmTarget untouched', async function() {
    var mockRobot = { _egmActive: false, _egmTarget: null };
    var node = new (loadNodeType('./nodes/gofa-egm-move', { nodesById: { r1: mockRobot } }))({ robot: 'r1', outputPayload: true });
    var err = await runInput(node, { payload: [1, 2, 3, 4, 5, 6] });
    assert.strictEqual(err, undefined);
    assert.strictEqual(node.errors.length, 0, 'fallback is not an error condition');
    assert.strictEqual(node.sent.length, 1);
    assert.strictEqual(node.sent[0][0], null);
    assert.deepStrictEqual(node.sent[0][1].payload, [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(mockRobot._egmTarget, null, 'must not touch the live target when no session is active');
});
await checkAsync('gofa-egm-move: {joints:[...]} input is accepted and normalized to a bare array on output (gofa-movej compatible)', async function() {
    var mockRobot = { _egmActive: false, _egmTarget: null };
    var node = new (loadNodeType('./nodes/gofa-egm-move', { nodesById: { r1: mockRobot } }))({ robot: 'r1', outputPayload: true });
    await runInput(node, { payload: { joints: [10, 20, 30, 40, 50, 60] } });
    assert.deepStrictEqual(node.sent[0][1].payload, [10, 20, 30, 40, 50, 60]);
});

// gofa-robot: discover (auto-discovery) ──────────────────────────────────────
await checkAsync('discover: finds mock RWS server on loopback interface', async function() {
    var server = http.createServer(function(req, res) {
        if (req.url === '/rw/system') {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ABB Robot Web Services"' });
            res.end();
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    var port = await new Promise(function(resolve) { server.listen(0, '127.0.0.1', function() { resolve(server.address().port); }); });
    try {
        var ips = await robot.discover({ includeInternal: true, rwsPort: port, timeout: 300 });
        assert.ok(ips.indexOf('127.0.0.1') >= 0, 'should discover 127.0.0.1');
    } finally {
        server.close();
    }
});

await checkAsync('discover: returns empty list when no servers respond', async function() {
    var ips = await robot.discover({ includeInternal: true, rwsPort: 65530, timeout: 300 });
    assert.deepStrictEqual(ips, [], 'should return empty array when no port is open');
});

await checkAsync('discover: filters out non-ABB servers', async function() {
    var server = http.createServer(function(req, res) {
        res.writeHead(404);
        res.end();
    });
    var port = await new Promise(function(resolve) { server.listen(0, '127.0.0.1', function() { resolve(server.address().port); }); });
    try {
        var ips = await robot.discover({ includeInternal: true, rwsPort: port, timeout: 300 });
        assert.deepStrictEqual(ips, [], 'should filter out non-ABB server');
    } finally {
        server.close();
    }
});
await checkAsync('discover: does NOT false-positive on an ordinary device returning a bare 200 (e.g. a router/NAS admin UI)', async function() {
    var server = http.createServer(function(req, res) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>some unrelated admin login page</html>');
    });
    var port = await new Promise(function(resolve) { server.listen(0, '127.0.0.1', function() { resolve(server.address().port); }); });
    try {
        var ips = await robot.discover({ includeInternal: true, rwsPort: port, timeout: 300 });
        assert.deepStrictEqual(ips, [], 'a bare 200 with no ABB WWW-Authenticate realm must not be mistaken for the robot');
    } finally {
        server.close();
    }
});
await checkAsync('discover: does NOT false-positive on an ordinary device returning a bare 401 (e.g. anything behind Basic/Digest auth)', async function() {
    var server = http.createServer(function(req, res) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Router Admin"' });
        res.end();
    });
    var port = await new Promise(function(resolve) { server.listen(0, '127.0.0.1', function() { resolve(server.address().port); }); });
    try {
        var ips = await robot.discover({ includeInternal: true, rwsPort: port, timeout: 300 });
        assert.deepStrictEqual(ips, [], 'a bare 401 with a non-ABB realm must not be mistaken for the robot');
    } finally {
        server.close();
    }
});

// gofa-robot: JSON socket protocol ──────────────────────────────────────────
await checkAsync('socketSend: translates legacy commands to JSON and parses JSON response', async function() {
    var net = require('net');
    var received = [];
    var server = net.createServer(function(socket) {
        socket.on('data', function(data) {
            var msg = data.toString().trim();
            received.push(msg);
            if (msg.indexOf('{"cmd":"ping"}') >= 0) {
                socket.write('{"status":"ok","cmd":"ping"}\n');
            } else if (msg.indexOf('{"cmd":"gotoj"') >= 0) {
                socket.write('{"status":"ok","cmd":"goto"}\n');
            } else if (msg.indexOf('{"cmd":"getvar"') >= 0) {
                socket.write('{"status":"ok","cmd":"getvar","val":"42"}\n');
            } else {
                socket.write('{"status":"err","cmd":"unknown","msg":"test error"}\n');
            }
        });
    });
    var port = await new Promise(function(resolve) { server.listen(0, '127.0.0.1', function() { resolve(server.address().port); }); });
    try {
        var client = createRobotClient({ ip: '127.0.0.1', socketPort: port });
        
        var resp1 = await client.socketSend('PING');
        assert.strictEqual(resp1, 'OK:PING');
        assert.strictEqual(received[0], '{"cmd":"ping"}');

        var resp2 = await client.socketSend('GOTOJ10;20;30;0.5;0.5;0.5;0.5;0;0;0;0');
        assert.strictEqual(resp2, 'OK:GOTO');
        assert.ok(received[1].indexOf('"cmd":"gotoj"') >= 0);

        var resp3 = await client.socketSend('GETVAR:nTest');
        assert.strictEqual(resp3, 'VAL:42');
        assert.strictEqual(received[2], '{"cmd":"getvar","name":"nTest"}');
        
        var respObj = await client.socketSend({ cmd: 'ping' });
        assert.strictEqual(respObj, 'OK:PING');
        assert.strictEqual(received[3], '{"cmd":"ping"}');

        var resp4 = await client.socketSend('BOGUS');
        assert.strictEqual(resp4, 'ERR:UNKNOWN');
    } finally {
        server.close();
    }
});

await checkAsync('socketSend: legacy fallback works when server replies with string', async function() {
    var net = require('net');
    var server = net.createServer(function(socket) {
        socket.on('data', function(data) {
            socket.write('OK:PING\n');
        });
    });
    var port = await new Promise(function(resolve) { server.listen(0, '127.0.0.1', function() { resolve(server.address().port); }); });
    try {
        var client = createRobotClient({ ip: '127.0.0.1', socketPort: port });
        var resp = await client.socketSend('PING');
        assert.strictEqual(resp, 'OK:PING');
    } finally {
        server.close();
    }
});

// ── gofa-grip ───────────────────────────────────────────────────────────────
await checkAsync('gofa-grip: accepts valid on/off inputs', async function() {
    var posted = [];
    var mockRobot = {
        rwsPost: function(path, body) {
            posted.push({ path: path, body: body });
            return Promise.resolve();
        }
    };
    var node = new (loadNodeType('./nodes/gofa-grip', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'on', signal: 'DO1' });
    var msg1 = { payload: 'on' };
    await runInput(node, msg1);
    assert.deepStrictEqual(msg1.payload, { ok: true, action: 'on', signal: 'DO1' });
    assert.deepStrictEqual(posted[0], { path: '/rw/iosystem/signals/DO1/set-value', body: 'lvalue=1' });

    var msg2 = { payload: 'off' };
    await runInput(node, msg2);
    assert.deepStrictEqual(msg2.payload, { ok: true, action: 'off', signal: 'DO1' });
    assert.deepStrictEqual(posted[1], { path: '/rw/iosystem/signals/DO1/set-value', body: 'lvalue=0' });
});

await checkAsync('gofa-grip: rejects invalid numeric payload >1', async function() {
    var mockRobot = { rwsPost: function() { return Promise.resolve(); } };
    var node = new (loadNodeType('./nodes/gofa-grip', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: 5 };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(/Invalid grip action/.test(msg.payload.error));
});

// ── gofa-leadthrough ─────────────────────────────────────────────────
await checkAsync('gofa-leadthrough: safety STOP success triggers lead-through enable', async function() {
    var sent = [];
    var posted = [];
    var mockRobot = {
        socketSend: function(cmd) { sent.push(cmd); return Promise.resolve('OK:STOP'); },
        rwsPost: function(path, body) { posted.push({ path: path, body: body }); return Promise.resolve(); },
        rwsGet: function() { return Promise.resolve('<span class="status">Active</span>'); },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-leadthrough', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: {} };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.deepStrictEqual(sent, [{ cmd: 'stop' }]);
    assert.deepStrictEqual(posted, [{ path: '/rw/motionsystem/mechunits/ROB_1/lead-through', body: 'status=active' }]);
});

await checkAsync('gofa-leadthrough: POST succeeds but safety controller reverts status to Inactive -> reports ok:false', async function() {
    var mockRobot = {
        socketSend: function() { return Promise.resolve('OK:STOP'); },
        rwsPost: function() { return Promise.resolve(); },
        rwsGet: function() { return Promise.resolve('<span class="status">Inactive</span>'); },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-leadthrough', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: {} };
    var err = await runInput(node, msg);
    assert.ok(err, 'must report an error instead of a false ok:true');
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('did not reach "Active"') >= 0, msg.payload.error);
});

await checkAsync('gofa-leadthrough: safety STOP RWS error blocks lead-through enable', async function() {
    var sent = [];
    var posted = [];
    var mockRobot = {
        socketSend: function(cmd) { sent.push(cmd); return Promise.resolve('ERR:STOP'); },
        rwsPost: function(path, body) { posted.push({ path: path, body: body }); return Promise.resolve(); }
    };
    var node = new (loadNodeType('./nodes/gofa-leadthrough', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var err = await runInput(node, { payload: {} });
    assert.ok(err);
    assert.strictEqual(posted.length, 0);
});

await checkAsync('gofa-leadthrough: safety STOP socket connection failure is swallowed and proceeds', async function() {
    var posted = [];
    var mockRobot = {
        socketSend: function() { return Promise.reject(new Error('socket closed')); },
        rwsPost: function(path, body) { posted.push({ path: path, body: body }); return Promise.resolve(); },
        rwsGet: function() { return Promise.resolve('<span class="status">Active</span>'); },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-leadthrough', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: {} };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(posted.length, 1);
});

// ── gofa-move ───────────────────────────────────────────────────────────────
await checkAsync('gofa-move: allows HOME and SETHOME', async function() {
    var sent = [];
    var mockRobot = { socketSend: function(cmd) { sent.push(cmd); return Promise.resolve('OK:HOME'); } };
    var node = new (loadNodeType('./nodes/gofa-move', { nodesById: { r1: mockRobot } }))({ robot: 'r1', command: 'HOME' });
    var msg = { payload: 'SETHOME' };
    await runInput(node, msg);
    assert.deepStrictEqual(sent, [{ cmd: 'sethome' }]);
    assert.strictEqual(msg.payload.ok, true);
});

await checkAsync('gofa-move: rejects non-HOME/SETHOME commands', async function() {
    var mockRobot = { socketSend: function() { return Promise.resolve('OK:BOGUS'); } };
    var node = new (loadNodeType('./nodes/gofa-move', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: 'BOGUS' };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(/Invalid command/.test(msg.payload.error));
});

// ── gofa-jog ────────────────────────────────────────────────────────────────
await checkAsync('gofa-jog: accepts valid axis, dir, step', async function() {
    var sent = [];
    var mockRobot = { socketSend: function(cmd) { sent.push(cmd); return Promise.resolve('OK:JOG'); } };
    var node = new (loadNodeType('./nodes/gofa-jog', { nodesById: { r1: mockRobot } }))({ robot: 'r1', axis: 'X', dir: '+', step: 10 });
    var msg = { payload: { axis: 'RY', dir: '-', step: 15 } };
    await runInput(node, msg);
    assert.deepStrictEqual(sent, [{ cmd: 'jog', axis: 'Y', sgn: '-', val: 15, rot: true }]);
    assert.strictEqual(msg.payload.ok, true);
});

await checkAsync('gofa-jog: rejects non-string and invalid axis', async function() {
    var mockRobot = { socketSend: function() { return Promise.resolve('OK:JOG'); } };
    var node = new (loadNodeType('./nodes/gofa-jog', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg1 = { payload: { axis: null } };
    await runInput(node, msg1);
    assert.strictEqual(msg1.payload.ok, false);
    assert.ok(/Invalid or missing axis/.test(msg1.payload.error));

    var msg2 = { payload: { axis: 'BOGUS' } };
    await runInput(node, msg2);
    assert.strictEqual(msg2.payload.ok, false);
    assert.ok(/Invalid axis/.test(msg2.payload.error));
});

await checkAsync('gofa-jog: rejects invalid dir and non-numeric step', async function() {
    var mockRobot = { socketSend: function() { return Promise.resolve('OK:JOG'); } };
    var node = new (loadNodeType('./nodes/gofa-jog', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg1 = { payload: { dir: '=' } };
    await runInput(node, msg1);
    assert.strictEqual(msg1.payload.ok, false);
    assert.ok(/Invalid direction/.test(msg1.payload.error));

    var msg2 = { payload: { step: 'NaN' } };
    await runInput(node, msg2);
    assert.strictEqual(msg2.payload.ok, false);
    assert.ok(/Invalid step value/.test(msg2.payload.error));
});

// ── gofa-joint-jog ──────────────────────────────────────────────────────────
await checkAsync('gofa-joint-jog: accepts valid joint, dir, step', async function() {
    var sent = [];
    var mockRobot = { socketSend: function(cmd) { sent.push(cmd); return Promise.resolve('OK:JOINTJOG'); } };
    var node = new (loadNodeType('./nodes/gofa-joint-jog', { nodesById: { r1: mockRobot } }))({ robot: 'r1', joint: 'J1', dir: '+', step: 5 });
    var msg = { payload: { joint: 'J3', dir: '-', step: 10 } };
    await runInput(node, msg);
    assert.deepStrictEqual(sent, [{ cmd: 'jointjog', joint: 3, sgn: '-', val: 10 }]);
    assert.strictEqual(msg.payload.ok, true);
});

await checkAsync('gofa-joint-jog: rejects invalid joint numbers', async function() {
    var mockRobot = { socketSend: function() { return Promise.resolve('OK:JOINTJOG'); } };
    var node = new (loadNodeType('./nodes/gofa-joint-jog', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg1 = { payload: { joint: 'J7' } };
    await runInput(node, msg1);
    assert.strictEqual(msg1.payload.ok, false);
    assert.ok(/Invalid joint/.test(msg1.payload.error));

    var msg2 = { payload: { joint: 0 } };
    await runInput(node, msg2);
    assert.strictEqual(msg2.payload.ok, false);
    assert.ok(/Invalid joint/.test(msg2.payload.error));
});

// ── gofa-motor ──────────────────────────────────────────────────────────────
await checkAsync('gofa-motor: accepts valid motor actions', async function() {
    var posted = [];
    var mockRobot = { rwsPost: function(path, body) { posted.push({ path: path, body: body }); return Promise.resolve(); } };
    var node = new (loadNodeType('./nodes/gofa-motor', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'motoron' });
    var msg = { payload: 'MOTOROFF' };
    await runInput(node, msg);
    assert.deepStrictEqual(posted, [{ path: '/rw/panel/ctrl-state', body: 'ctrl-state=motoroff' }]);
    assert.strictEqual(msg.payload.ok, true);
});

await checkAsync('gofa-motor: rejects invalid motor actions', async function() {
    var mockRobot = { rwsPost: function() { return Promise.resolve(); } };
    var node = new (loadNodeType('./nodes/gofa-motor', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: 'BOGUS' };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(/Invalid action/.test(msg.payload.error));
});

// gofa-asi-led / gofa-pose / gofa-joints / gofa-status / gofa-rapid-var-read /
// gofa-save-point / gofa-file — Tier 6 fixes (agy, parallel batch D1-D6) ──

await checkAsync('gofa-asi-led: counted blink sequence completes', async function() {
    var calls = [];
    var mockRobot = {
        socketSend: function(cmd) {
            calls.push(cmd);
            return Promise.resolve('OK:SETLED');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-asi-led', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', red: 255, grn: 0, blu: 0, blinkCount: 2, blinkMs: 10
    });
    var msg = { payload: {} };
    var inputPromise = runInput(node, msg);
    await inputPromise;
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.blinks, 2);
    assert.strictEqual(calls.length, 5);
    assert.deepStrictEqual(calls[0].val, [255, 0, 0, 0]);
    assert.deepStrictEqual(calls[1].val, [0, 0, 0, 0]);
    assert.deepStrictEqual(calls[2].val, [255, 0, 0, 0]);
    assert.deepStrictEqual(calls[3].val, [0, 0, 0, 0]);
    assert.deepStrictEqual(calls[4].val, [0, 0, 0, 0]);
});

await checkAsync('gofa-asi-led: counted blink sequence is interrupted by new input', async function() {
    var calls = [];
    var mockRobot = {
        socketSend: function(cmd) {
            calls.push(cmd);
            return Promise.resolve('OK:SETLED');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-asi-led', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', red: 255, grn: 0, blu: 0, blinkCount: 5, blinkMs: 50
    });
    var msg1 = {};
    var run1 = runInput(node, msg1);

    await new Promise(function(resolve) { setTimeout(resolve, 10); });

    var msg2 = { payload: 'reset' };
    mockRobot.socketSend = function(cmd) {
        calls.push(cmd);
        return Promise.resolve('OK:RESETLED');
    };
    var run2 = runInput(node, msg2);

    await run1;
    await run2;

    assert.strictEqual(calls[calls.length - 1].cmd, 'resetled');
});

await checkAsync('gofa-asi-led: reset restores static green', async function() {
    var calls = [];
    var mockRobot = {
        socketSend: function(cmd) {
            calls.push(cmd);
            return Promise.resolve('OK:RESETLED');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-asi-led', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: 'reset' };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.reset, true);
    assert.deepStrictEqual(calls[0], { cmd: 'resetled' });
});

await checkAsync('gofa-asi-led: sets static led color', async function() {
    var calls = [];
    var mockRobot = {
        socketSend: function(cmd) {
            calls.push(cmd);
            return Promise.resolve('OK:SETLED');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-asi-led', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', red: 255, grn: 0, blu: 0, period: 0
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.r, 255);
    assert.deepStrictEqual(calls[0], { cmd: 'setled', val: [255, 0, 0, 0] });
});

await checkAsync('gofa-asi-led: RWS transport writes the four GO signals via /set-value instead of the socket (works while RAPID is stopped)', async function() {
    var calls = [];
    var mockRobot = { rwsPost: function(p, body) { calls.push({ path: p, body: body }); return Promise.resolve(); } };
    var node = new (loadNodeType('./nodes/gofa-asi-led', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', red: 0, grn: 200, blu: 200, period: 0, transport: 'rws'
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.transport, 'rws');
    assert.strictEqual(calls[0].path, '/rw/iosystem/signals/Asi1LedRed/set-value');
    assert.strictEqual(calls[0].body, 'lvalue=0');
    assert.strictEqual(calls[1].path, '/rw/iosystem/signals/Asi1LedGreen/set-value');
    assert.strictEqual(calls[1].body, 'lvalue=200');
    assert.strictEqual(calls[2].path, '/rw/iosystem/signals/Asi1LedBlue/set-value');
    assert.strictEqual(calls[2].body, 'lvalue=200');
    assert.strictEqual(calls[3].path, '/rw/iosystem/signals/Asi1LedPeriod/set-value');
    assert.strictEqual(calls[3].body, 'lvalue=0');
});

await checkAsync('gofa-asi-led: RWS transport reset writes static green (0,255,0) instead of sending RESETLED', async function() {
    var calls = [];
    var mockRobot = { rwsPost: function(p, body) { calls.push({ path: p, body: body }); return Promise.resolve(); } };
    var node = new (loadNodeType('./nodes/gofa-asi-led', { nodesById: { r1: mockRobot } }))({ robot: 'r1', transport: 'rws' });
    var msg = { payload: 'reset' };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.reset, true);
    assert.strictEqual(calls[1].path, '/rw/iosystem/signals/Asi1LedGreen/set-value');
    assert.strictEqual(calls[1].body, 'lvalue=255');
});

await checkAsync('gofa-asi-led: msg.payload.transport overrides the configured transport at runtime', async function() {
    var socketCalled = false, rwsCalled = false;
    var mockRobot = {
        socketSend: function() { socketCalled = true; return Promise.resolve('OK:SETLED'); },
        rwsPost: function() { rwsCalled = true; return Promise.resolve(); }
    };
    var node = new (loadNodeType('./nodes/gofa-asi-led', { nodesById: { r1: mockRobot } }))({ robot: 'r1', red: 255, transport: 'socket' });
    var msg = { payload: { r: 255, transport: 'rws' } };
    await runInput(node, msg);
    assert.strictEqual(rwsCalled, true);
    assert.strictEqual(socketCalled, false);
});

await checkAsync('gofa-asi-led: RWS transport counted blink sequence uses /set-value for every step', async function() {
    var calls = [];
    var mockRobot = { rwsPost: function(p) { calls.push(p); return Promise.resolve(); } };
    var node = new (loadNodeType('./nodes/gofa-asi-led', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', red: 255, grn: 0, blu: 0, blinkCount: 2, blinkMs: 10, transport: 'rws'
    });
    var msg = { payload: {} };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.blinks, 2);
    assert.strictEqual(calls.filter(function(p) { return p === '/rw/iosystem/signals/Asi1LedRed/set-value'; }).length, 5);
});

await checkAsync('gofa-joints: error during joints fetch sets red status and propagates error', async function() {
    var mockRobot = {
        rwsGet: function() {
            return Promise.reject(new Error('RWS connection error'));
        }
    };
    var node = new (loadNodeType('./nodes/gofa-joints', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    var err = await runInput(node, msg);
    assert.ok(err);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(node.errors.length, 1);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'red' && s.text === 'error'; }));
});

await checkAsync('gofa-joints: missing robot config reports an error and sets red status', async function() {
    var node = new (loadNodeType('./nodes/gofa-joints', { nodesById: {} }))({ robot: 'nope' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(node.errors.length, 1);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'red' && s.text === 'no robot'; }));
});

await checkAsync('gofa-joints: successful joints fetch sets green status and returns ok:true', async function() {
    var sampleJointsBody = '<span class="rax_1">10</span><span class="rax_2">20</span><span class="rax_3">30</span>' +
        '<span class="rax_4">40</span><span class="rax_5">50</span><span class="rax_6">60</span>';
    var mockRobot = {
        rwsGet: function(path) {
            assert.ok(path.indexOf('/rw/motionsystem/mechunits/ROB_1/jointtarget') >= 0);
            return Promise.resolve(sampleJointsBody);
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-joints', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.j1, 10);
    assert.strictEqual(msg.payload.j6, 60);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'blue' && s.text === 'reading...'; }), 'should set blue reading status first');
    assert.ok(node.statuses.some(function(s) { return s.fill === 'green' && s.text === 'read'; }));
});

await checkAsync('gofa-pose: error during pose fetch sets red status and propagates error', async function() {
    var mockRobot = {
        rwsGet: function() {
            return Promise.reject(new Error('RWS connection error'));
        }
    };
    var node = new (loadNodeType('./nodes/gofa-pose', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    var err = await runInput(node, msg);
    assert.ok(err);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(node.errors.length, 1);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'red' && s.text === 'error'; }));
});

await checkAsync('gofa-pose: missing robot config reports an error and sets red status', async function() {
    var node = new (loadNodeType('./nodes/gofa-pose', { nodesById: {} }))({ robot: 'nope' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(node.errors.length, 1);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'red' && s.text === 'no robot'; }));
});

await checkAsync('gofa-pose: successful pose fetch sets green status with coordinates and returns ok:true', async function() {
    var samplePoseBody = '<span class="x">1.23</span><span class="y">4.56</span><span class="z">7.89</span>' +
        '<span class="q1">0.1</span><span class="q2">0.2</span><span class="q3">0.3</span><span class="q4">0.4</span>' +
        '<span class="cf1">1</span><span class="cf4">2</span><span class="cf6">3</span><span class="cfx">4</span>';
    var mockRobot = {
        rwsGet: function(path) {
            assert.ok(path.indexOf('/rw/motionsystem/mechunits/ROB_1/robtarget') >= 0);
            return Promise.resolve(samplePoseBody);
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-pose', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.x, 1.23);
    assert.strictEqual(msg.payload.y, 4.56);
    assert.strictEqual(msg.payload.cf1, 1);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'blue' && s.text === 'reading...'; }), 'should set blue reading status first');
    assert.ok(node.statuses.some(function(s) { return s.fill === 'green' && s.text === 'x=1.2 y=4.6'; }), 'should set green status with coordinates');
});

await checkAsync('gofa-rapid-var-read: propagates socket connectivity errors without falling back to module-text', async function() {
    var rwsGetCalled = false;
    var mockRobot = {
        socketSend: function() { return Promise.reject(new Error('socket timeout')); },
        rwsGet: function() {
            rwsGetCalled = true;
            return Promise.resolve('PERS num nOther := 42;');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-rapid-var-read', { nodesById: { r1: mockRobot } }))({ robot: 'r1', variable: 'nOther' });
    var msg = {};
    var err = await runInput(node, msg);
    assert.ok(err, 'should pass the socket error to done()');
    assert.strictEqual(err.message, 'socket timeout');
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(msg.payload.error, 'socket timeout');
    assert.strictEqual(rwsGetCalled, false, 'should not call rwsGet or fall back to module-text on connection error');
});

await checkAsync('gofa-save-point: a blank name is passed through to addPoint (auto-numbered "Point N"), not rejected', async function() {
    // resolvePointName() in gofa-robot.js already auto-generates "Point N" for a
    // blank name — this is a real, intentional feature (the demo flow's
    // gofa-save-point nodes rely on it: pointName left blank on purpose). An
    // earlier version of this fix incorrectly rejected blank names outright.
    var sampleTargetBody = '<span class="x">1</span><span class="y">2</span><span class="z">3</span>' +
        '<span class="q1">0</span><span class="q2">0</span><span class="q3">0</span><span class="q4">1</span>' +
        '<span class="cf1">0</span><span class="cf4">0</span><span class="cf6">0</span><span class="cfx">0</span>';
    var mockRobot = {
        rwsGet: function() { return Promise.resolve(sampleTargetBody); },
        parseXhtml: parseXhtml,
        addPoint: function(name, target) { return { id: 'p1', name: 'Point 1', target: target }; },
        getPoints: function() { return [{ id: 'p1', name: 'Point 1' }]; }
    };
    var node = new (loadNodeType('./nodes/gofa-save-point', { nodesById: { r1: mockRobot } }))({ robot: 'r1', pointName: '' });
    var msg = { payload: { name: '  ' } };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.point.name, 'Point 1');
});

await checkAsync('gofa-status: error during status fetch sets red status and propagates error', async function() {
    var mockRobot = {
        rwsGet: function() {
            return Promise.reject(new Error('RWS connection error'));
        }
    };
    var node = new (loadNodeType('./nodes/gofa-status', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    var err = await runInput(node, msg);
    assert.ok(err);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(node.errors.length, 1);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'red' && s.text === 'error'; }));
});

await checkAsync('gofa-status: missing robot config reports an error and sets red status', async function() {
    var node = new (loadNodeType('./nodes/gofa-status', { nodesById: {} }))({ robot: 'nope' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(node.errors.length, 1);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'red' && s.text === 'no robot'; }));
});

await checkAsync('gofa-status: successful status fetch sets green status and returns ok:true', async function() {
    var mockRobot = {
        rwsGet: function(path) {
            if (path.indexOf('ctrl-state') >= 0) return Promise.resolve('<span class="ctrlstate">motoron</span>');
            if (path.indexOf('opmode') >= 0) return Promise.resolve('<span class="opmode">auto</span>');
            if (path.indexOf('speedratio') >= 0) return Promise.resolve('<span class="speedratio">75</span>');
            if (path.indexOf('execution') >= 0) return Promise.resolve('<span class="ctrlexecstate">running</span>');
            return Promise.reject(new Error('unexpected path: ' + path));
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-status', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.ctrlstate, 'motoron');
    assert.strictEqual(msg.payload.opmode, 'auto');
    assert.strictEqual(msg.payload.speed, 75);
    assert.strictEqual(msg.payload.rapid, 'running');
    assert.ok(node.statuses.some(function(s) { return s.fill === 'blue' && s.text === 'reading...'; }), 'should set blue reading status first');
    assert.ok(node.statuses.some(function(s) { return s.fill === 'green' && s.text === 'motoron'; }));
});

await checkAsync('gofa-connection-status: missing robot config reports an error and sets red status', async function() {
    var node = new (loadNodeType('./nodes/gofa-connection-status', { nodesById: {} }))({ robot: 'nope' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(node.errors.length, 1);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'red' && s.text === 'no robot'; }));
});

await checkAsync('gofa-connection-status: both RWS and socket reachable reports ok:true', async function() {
    var mockRobot = {
        ip: '10.0.0.5',
        rwsGet: function(path) {
            if (path.indexOf('ctrl-state') >= 0) return Promise.resolve('<span class="ctrlstate">motoron</span>');
            if (path.indexOf('opmode') >= 0) return Promise.resolve('<span class="opmode">auto</span>');
            if (path.indexOf('speedratio') >= 0) return Promise.resolve('<span class="speedratio">75</span>');
            if (path.indexOf('execution') >= 0) return Promise.resolve('<span class="ctrlexecstate">running</span>');
            return Promise.reject(new Error('unexpected path: ' + path));
        },
        parseXhtml: parseXhtml,
        socketSend: function() { return Promise.resolve('OK:PING'); }
    };
    var node = new (loadNodeType('./nodes/gofa-connection-status', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.ip, '10.0.0.5');
    assert.strictEqual(msg.payload.rws.ok, true);
    assert.strictEqual(msg.payload.rws.motors, 'motoron');
    assert.strictEqual(msg.payload.socket.ok, true);
    assert.strictEqual(typeof msg.payload.socket.rtt, 'number');
    assert.deepStrictEqual(msg.payload.errors, []);
    assert.ok(node.statuses.some(function(s) { return s.fill === 'green'; }));
    assert.strictEqual(node.errors.length, 0, 'a healthy check must not raise a node error');
});

await checkAsync('gofa-connection-status: RWS down but socket up reports ok:false with rws.ok:false, socket.ok:true', async function() {
    var mockRobot = {
        ip: '10.0.0.5',
        rwsGet: function() { return Promise.reject(new Error('RWS connection error')); },
        parseXhtml: parseXhtml,
        socketSend: function() { return Promise.resolve('OK:PING'); }
    };
    var node = new (loadNodeType('./nodes/gofa-connection-status', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(msg.payload.rws.ok, false);
    assert.strictEqual(msg.payload.socket.ok, true);
    assert.strictEqual(msg.payload.errors.length, 4, 'all four RWS calls should be reported as failed');
    assert.ok(node.statuses.some(function(s) { return s.fill === 'red' && s.text === 'RWS unreachable'; }));
    assert.strictEqual(node.errors.length, 0, 'a degraded-but-completed check must not raise a node error');
});

await checkAsync('gofa-connection-status: RWS up but socket down reports ok:false with rws.ok:true, socket.ok:false', async function() {
    var mockRobot = {
        ip: '10.0.0.5',
        rwsGet: function(path) {
            if (path.indexOf('ctrl-state') >= 0) return Promise.resolve('<span class="ctrlstate">motoron</span>');
            return Promise.reject(new Error('unexpected path: ' + path));
        },
        parseXhtml: parseXhtml,
        socketSend: function() { return Promise.reject(new Error('socket timeout')); }
    };
    var node = new (loadNodeType('./nodes/gofa-connection-status', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(msg.payload.rws.ok, true);
    assert.strictEqual(msg.payload.rws.motors, 'motoron');
    assert.strictEqual(msg.payload.socket.ok, false);
    assert.strictEqual(msg.payload.socket.error, 'socket timeout');
    assert.ok(node.statuses.some(function(s) { return s.fill === 'yellow' && s.text === 'socket unreachable'; }));
    assert.strictEqual(node.errors.length, 0);
});

await checkAsync('gofa-connection-status: default outputPayload strips the result to a bare signal', async function() {
    var mockRobot = {
        ip: '10.0.0.5',
        rwsGet: function() { return Promise.resolve('<span class="ctrlstate">motoron</span>'); },
        parseXhtml: parseXhtml,
        socketSend: function() { return Promise.resolve('OK:PING'); }
    };
    var node = new (loadNodeType('./nodes/gofa-connection-status', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    var sent = node.sent[node.sent.length - 1];
    assert.deepStrictEqual(Object.keys(sent), [], 'default (unchecked) output must carry no payload');
});

await checkAsync('gofa-file: skips patching for binary buffers and preserves bytes exactly', async function() {
    var calls = [];
    var mockRobot = {
        ip: '10.0.0.9',
        rwsPut: function(p, b, contentType) {
            calls.push({ path: p, body: b, contentType: contentType });
            return Promise.resolve('');
        }
    };
    var binaryData = Buffer.from([0x00, 0x80, 0xC0, 0xFF, 0x01, 0x02]);
    var node = new (loadNodeType('./nodes/gofa-file', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', action: 'upload', remotePath: '$HOME/Programs/binary.bin'
    });
    var msg = { payload: binaryData };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.serverIpInjected, false);
    assert.strictEqual(calls.length, 1);
    assert.ok(Buffer.compare(calls[0].body, binaryData) === 0, 'binary bytes must be preserved exactly');
});

await checkAsync('gofa-movej: moves to configured joints on input', async function() {
    var calls = [];
    var mockRobot = {
        socketSend: function(cmd) {
            calls.push(cmd);
            return Promise.resolve('OK:MOVEJ');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-movej', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', joints: '[10,20,30,40,50,60]'
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.deepStrictEqual(msg.payload.joints, [10,20,30,40,50,60]);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { cmd: 'movej', val: [10,20,30,40,50,60] });
    assert.strictEqual(msg.payload.moveType, 'J');
});

await checkAsync('gofa-movej: Move type L sends movel; msg.moveType overrides config', async function() {
    var calls = [];
    var mockRobot = { socketSend: function(cmd) { calls.push(cmd); return Promise.resolve('OK:MOVEL'); } };
    var Ctor = loadNodeType('./nodes/gofa-movej', { nodesById: { r1: mockRobot } });
    var node = new Ctor({ robot: 'r1', joints: '[1,2,3,4,5,6]', moveType: 'L' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.moveType, 'L');
    assert.strictEqual(calls[0].cmd, 'movel');
    // per-message override back to J; bogus values resolve to J too
    var node2 = new Ctor({ robot: 'r1', joints: '[1,2,3,4,5,6]', moveType: 'L' });
    var msg2 = { moveType: 'J' };
    await runInput(node2, msg2);
    assert.strictEqual(calls[1].cmd, 'movej');
    var node3 = new Ctor({ robot: 'r1', joints: '[1,2,3,4,5,6]' });
    var msg3 = { payload: { j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: 6, moveType: 'L' } };
    await runInput(node3, msg3);
    assert.strictEqual(calls[2].cmd, 'movel');
});

check('translateToJSON: legacy MOVEL token maps to movel cmd', function() {
    var robotModule = require('./nodes/gofa-robot');
    var client = robotModule.createRobotClient({ ip: 'x', rwsPort: 443, socketPort: 1, username: 'u', password: 'p' });
    // translateToJSON is internal to the client; exercise it via the documented
    // token->JSON contract instead: both .mod files must contain the movel case.
    var fs2 = require('fs');
    ['rapid/MainModule.mod', 'rapid/MainModuleEGM.mod'].forEach(function(f) {
        var mod = fs2.readFileSync(f, 'utf8');
        assert.ok(mod.indexOf('CASE "movej", "movel":') >= 0, f + ' missing JSON movel case');
        assert.ok(mod.indexOf('= "MOVEL"') >= 0, f + ' missing legacy MOVEL token');
        assert.ok(mod.indexOf('CalcRobT(jt, tGripper') >= 0, f + ' missing CalcRobT linear path');
    });
});

await checkAsync('gofa-zone-set: sets zone and propagates config', async function() {
    var calls = [];
    var mockRobot = {
        socketSend: function(cmd) {
            calls.push(cmd);
            return Promise.resolve('OK:ZONE');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-zone-set', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', zone: 'z20'
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.zone, 'z20');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { cmd: 'zone', val: 'Z20' });
});

await checkAsync('gofa-speed-set: sets speed and respects clamping', async function() {
    var calls = [];
    var mockRobot = {
        socketSend: function(cmd) {
            calls.push(cmd);
            return Promise.resolve('OK:SPEED');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-speed-set', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', speed: 150
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.speed, 100); // clamped
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { cmd: 'speed', val: 100 });
});

await checkAsync('gofa-stop-motion: halts robot motion', async function() {
    var calls = [];
    var mockRobot = {
        socketSend: function(cmd) {
            calls.push(cmd);
            return Promise.resolve('OK:STOP');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-stop-motion', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { cmd: 'stop' });
});

await checkAsync('gofa-ping: calculates latency rtt', async function() {
    var calls = [];
    var mockRobot = {
        socketSend: function(cmd) {
            calls.push(cmd);
            return Promise.resolve('OK:PING');
        }
    };
    var node = new (loadNodeType('./nodes/gofa-ping', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.ok(typeof msg.payload.rtt === 'number');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { cmd: 'ping' });
});

await checkAsync('gofa-system-info: fetches details via RWS', async function() {
    var mockRobot = {
        rwsGet: function(path) {
            if (path === '/rw/system') return Promise.resolve('<span class="rwversion">7.21</span>');
            if (path === '/ctrl/identity') return Promise.resolve('<span class="ctrl-name">my_gofa</span>');
            return Promise.reject(new Error('unexpected path'));
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-system-info', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.rwVersion, '7.21');
    assert.strictEqual(msg.payload.ctrlName, 'my_gofa');
});

await checkAsync('gofa-io-list: lists and filters signals', async function() {
    var mockRobot = {
        rwsGet: function(path) {
            return Promise.resolve(
                '<li class="ios-signal-li"><span class="name">SIG1</span><span class="type">DO</span><span class="lvalue">0</span></li>' +
                '<li class="ios-signal-li"><span class="name">SIG2</span><span class="type">DI</span><span class="lvalue">1</span></li>'
            );
        }
    };
    var node = new (loadNodeType('./nodes/gofa-io-list', { nodesById: { r1: mockRobot } }))({ robot: 'r1' });
    var msg = { payload: { type: 'DO' } };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.count, 1);
    assert.strictEqual(msg.payload.signals[0].name, 'SIG1');
});

await checkAsync('gofa-di-read: reads value of digital input', async function() {
    var mockRobot = {
        rwsGet: function(path) {
            assert.ok(path.indexOf('MySignal') >= 0);
            return Promise.resolve('<span class="lvalue">1</span>');
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-di-read', { nodesById: { r1: mockRobot } }))({ robot: 'r1', signal: 'MySignal' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.signal, 'MySignal');
    assert.strictEqual(msg.payload.value, 1);
});

await checkAsync('gofa-leadthrough: disables manual guidance', async function() {
    var calls = [];
    var mockRobot = {
        rwsPost: function(path, body) {
            calls.push({ path: path, body: body });
            return Promise.resolve('');
        },
        rwsGet: function() { return Promise.resolve('<span class="status">Inactive</span>'); },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-leadthrough', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'disable' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].path, '/rw/motionsystem/mechunits/ROB_1/lead-through');
    assert.strictEqual(calls[0].body, 'status=inactive');
});

await checkAsync('gofa-leadthrough: disable POST succeeds but status stays Active -> reports ok:false', async function() {
    var mockRobot = {
        rwsPost: function() { return Promise.resolve(''); },
        rwsGet: function() { return Promise.resolve('<span class="status">Active</span>'); },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-leadthrough', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'disable' });
    var msg = {};
    var err = await runInput(node, msg);
    assert.ok(err, 'must report an error instead of a false ok:true');
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('did not reach "Inactive"') >= 0, msg.payload.error);
});

await checkAsync('gofa-subscribe-pose: polls pose and triggers timeout loop', async function() {
    var calls = [];
    var mockRobot = {
        rwsGet: function(path) {
            calls.push(path);
            return Promise.resolve('<span class="x">1.2</span><span class="y">3.4</span><span class="z">5.6</span><span class="q1">1</span><span class="q2">0</span><span class="q3">0</span><span class="q4">0</span>');
        },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-subscribe-pose', { nodesById: { r1: mockRobot } }))({ robot: 'r1', interval: 100, outputPayload: true });
    var msg = {};
    
    // Start polling
    await runInput(node, msg);
    assert.strictEqual(node.statuses[0].text, 'polling');
    
    // Give it a moment to run at least one poll loop
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(node.sent.length >= 1);
    assert.strictEqual(node.sent[0].payload.ok, true);
    assert.strictEqual(node.sent[0].payload.x, 1.2);
    
    // Stop polling
    await runInput(node, msg);
    assert.strictEqual(node.statuses[node.statuses.length - 1].text, 'stopped');
});

check('gate: default (outputPayload falsy) strips payload, keeps _msgid', function() {
    var sent = null;
    var gated = gate({}, function(m) { sent = m; });
    gated({ payload: { ok: true, secret: 42 }, _msgid: 'abc' });
    assert.deepStrictEqual(sent, { _msgid: 'abc' });
});

check('gate: outputPayload true passes msg through unchanged', function() {
    var sent = null;
    var gated = gate({ outputPayload: true }, function(m) { sent = m; });
    var msg = { payload: { ok: true, secret: 42 }, _msgid: 'abc' };
    gated(msg);
    assert.strictEqual(sent, msg);
});

check('gate: array form (2-output send) gates each non-null element independently', function() {
    var sent = null;
    var gated = gate({}, function(m) { sent = m; });
    gated([{ payload: 'x', _msgid: 'm1' }, null]);
    assert.deepStrictEqual(sent, [{ _msgid: 'm1' }, null]);
});

// ── gofa-mod-edit ────────────────────────────────────────────────────────────

check('gofa-mod-edit: parseFileList parses fs-file li entries, skips fs-dir', function() {
    var parseFileList = require('./nodes/gofa-mod-edit').parseFileList;
    var body =
        '<ul>' +
        '<li class="fs-dir" title="SubDir"><a href="/fileservice/$HOME/Programs/SubDir/">SubDir</a></li>' +
        '<li class="fs-file" title="MainModule.mod"><a href="/fileservice/$HOME/Programs/MainModule.mod">MainModule.mod</a></li>' +
        '<li class="fs-file"><span class="fs-name">gofa_points.json</span></li>' +
        '<li class="fs-file"><a href="/fileservice/%24HOME/Programs/Other.mod">Other.mod</a></li>' +
        '</ul>';
    var files = parseFileList(body);
    assert.deepStrictEqual(files, ['MainModule.mod', 'gofa_points.json', 'Other.mod']);
});

check('gofa-mod-edit: parseFileList falls back to bare anchors when no fs-file classes exist', function() {
    var parseFileList = require('./nodes/gofa-mod-edit').parseFileList;
    var body = '<div><a href="/fileservice/$HOME/Programs/A.mod">A.mod</a>' +
               '<a href="/fileservice/$HOME/Programs/B.json"></a>' +
               '<a href="x">..</a></div>';
    var files = parseFileList(body);
    assert.deepStrictEqual(files, ['A.mod', 'B.json']);
});

await checkAsync('gofa-mod-edit: no robot configured error', async function() {
    var node = new (loadNodeType('./nodes/gofa-mod-edit'))({ outputPayload: true, remotePath: '$HOME/Programs/X.mod', content: 'x' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(node.errors.length, 1);
});

await checkAsync('gofa-mod-edit: uploads stored content with SERVER_IP patched and right content-type', async function() {
    var call = null;
    var mockRobot = {
        ip: '10.0.0.5',
        rwsPut: function(path, body, contentType) {
            call = { path: path, body: body, contentType: contentType };
            return Promise.resolve('');
        }
    };
    var content = 'MODULE M\n    CONST string SERVER_IP := "1.2.3.4";\nENDMODULE\n';
    var node = new (loadNodeType('./nodes/gofa-mod-edit', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', outputPayload: true,
        remotePath: '$HOME/Programs/M.mod', content: content
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.serverIpInjected, true);
    assert.strictEqual(call.path, '/fileservice/$HOME/Programs/M.mod');
    assert.strictEqual(call.contentType, 'text/plain;v=2.0');
    assert.ok(call.body.toString('utf8').indexOf('SERVER_IP := "10.0.0.5"') >= 0);
    assert.strictEqual(msg.payload.bytes, call.body.length);
});

await checkAsync('gofa-mod-edit: uploads stored content without SERVER_IP patched when autoChangeIp is false', async function() {
    var call = null;
    var mockRobot = {
        ip: '10.0.0.5',
        rwsPut: function(path, body, contentType) {
            call = { path: path, body: body, contentType: contentType };
            return Promise.resolve('');
        }
    };
    var content = 'MODULE M\n    CONST string SERVER_IP := "1.2.3.4";\nENDMODULE\n';
    var node = new (loadNodeType('./nodes/gofa-mod-edit', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', outputPayload: true, autoChangeIp: false,
        remotePath: '$HOME/Programs/M.mod', content: content
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.serverIpInjected, false);
    assert.strictEqual(call.path, '/fileservice/$HOME/Programs/M.mod');
    assert.strictEqual(call.contentType, 'text/plain;v=2.0');
    assert.ok(call.body.toString('utf8').indexOf('SERVER_IP := "1.2.3.4"') >= 0);
    assert.strictEqual(msg.payload.bytes, call.body.length);
});

await checkAsync('gofa-mod-edit: empty content is rejected, nothing uploaded', async function() {
    var called = false;
    var mockRobot = { ip: '10.0.0.5', rwsPut: function() { called = true; return Promise.resolve(''); } };
    var node = new (loadNodeType('./nodes/gofa-mod-edit', { nodesById: { r1: mockRobot } }))({
        robot: 'r1', outputPayload: true, remotePath: '$HOME/Programs/M.mod', content: ''
    });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(called, false);
    assert.strictEqual(node.errors.length, 1);
});

// Project rule: rapid/*.mod at the repo root is the source of truth, but the
// package copy here is what ships on npm AND what gofa-setup uploads at
// runtime — every edit must land in both, same commit. prepack.js only syncs
// at publish time, so this check catches dev-time drift.
check('rapid modules: package copies are in sync with the repo-root source of truth', function() {
    ['MainModule.mod', 'MainModuleEGM.mod'].forEach(function(f) {
        var root = fs.readFileSync(path.join(__dirname, '..', 'rapid', f));
        var pkg  = fs.readFileSync(path.join(__dirname, 'rapid', f));
        assert.ok(root.equals(pkg), f + ' drifted — copy rapid/' + f + ' into node-red-contrib-abb-gofa/rapid/ (or run node prepack.js)');
    });
});

// gate.js (nodes/lib/gate.js) strips msg.payload down to {_msgid} whenever a
// node's Output payload checkbox is off — the right default for a user's own
// flow, but wrong for THESE bundled example/demo flows, whose entire purpose
// is showing a node's real output (debug sidebar, and — for
// teach_workflow_flow.json — the flow's own switch/change routing logic,
// which reads msg.payload.* directly). Confirmed live 2026-07-16: exactly
// this bug (no node had it set) silently broke all three example flows —
// nobody noticed until an unrelated audit found it (15ef5fa/566907a/
// 99b870d). Checks both flows/ (source of truth) and the npm-shipped
// examples/ copy, so a flow edit with a forgotten `node prepack.js` also
// fails loudly instead of shipping stale.
check('example flows: every gofa-* node instance has Output payload enabled', function() {
    var dirs = [path.join(__dirname, '..', 'flows'), path.join(__dirname, 'examples')];
    var problems = [];
    dirs.forEach(function(dir) {
        fs.readdirSync(dir).filter(function(f) { return f.endsWith('.json'); }).forEach(function(f) {
            var flow = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            flow.forEach(function(n) {
                if (n.type && n.type.indexOf('gofa-') === 0 && n.type !== 'gofa-robot' && n.outputPayload !== true) {
                    problems.push(path.basename(dir) + '/' + f + ': ' + (n.name || n.id) + ' (' + n.type + ')');
                }
            });
        });
    });
    assert.deepStrictEqual(problems, [], 'nodes missing outputPayload:true — ' + problems.join('; '));
});

// ── gofa-setup ───────────────────────────────────────────────────────────────
// Stateful fake robot: POSTs actually flip the state the next GET reports,
// so the node's verify-by-polling logic runs for real.
function makeSetupRobot(opts) {
    opts = opts || {};
    var st = {
        opmode:  opts.opmode || 'AUTO', // live controller reports opmode UPPERCASE
        ctrl:    opts.ctrl   || 'motoroff',
        exec:    opts.exec   || 'stopped',
        modules: opts.modules || [{ name: 'MainModuleEGM', type: 'ProgMod' }],
        pingOk:  opts.pingOk !== false,
        calls:   [],
        putBody: null
    };
    return {
        ip: '10.0.0.9',
        _st: st,
        rwsGet: function(p) {
            if (p === '/rw/panel/opmode')     return Promise.resolve('<span class="opmode">' + st.opmode + '</span>');
            if (p === '/rw/panel/ctrl-state') return Promise.resolve('<span class="ctrlstate">' + st.ctrl + '</span>');
            if (p === '/rw/rapid/execution')  return Promise.resolve('<span class="ctrlexecstate">' + st.exec + '</span>');
            if (p.indexOf('/modules') >= 0) {
                return Promise.resolve(st.modules.map(function(m) {
                    return '<li class="rap-module-info-li"><span class="name">' + m.name + '</span><span class="type">' + m.type + '</span></li>';
                }).join(''));
            }
            return Promise.resolve('');
        },
        rwsPost: function(p, b) {
            st.calls.push('POST ' + p);
            if (p === '/rw/rapid/execution/stop')  st.exec = 'stopped';
            if (p === '/rw/rapid/execution/start' && !opts.startFails) st.exec = 'running';
            if (p === '/rw/panel/ctrl-state')      st.ctrl = 'motoron';
            return Promise.resolve('');
        },
        rwsPostHal: function(p, b) { st.calls.push('HAL ' + p + ' ' + b); return Promise.resolve(''); },
        rwsPut: function(p, b, ct) { st.calls.push('PUT ' + p + ' ' + ct); st.putBody = b.toString(); return Promise.resolve(''); },
        withMastership: function(fn) { return fn(); },
        socketSend: function(cmd) {
            st.calls.push('SOCK ' + cmd);
            return st.pingOk ? Promise.resolve('OK:PING') : Promise.reject(new Error('connection refused'));
        }
    };
}
function makeSetupNode(robot, config) {
    var node = new (loadNodeType('./nodes/gofa-setup', { nodesById: { r1: robot } }))(
        Object.assign({ robot: 'r1', outputPayload: true }, config || {}));
    node._t = { poll: 5, stop: 200, motoron: 200, start: 200, ping: 100 };
    return node;
}

await checkAsync('gofa-setup: full happy path runs all 9 steps in order', async function() {
    var robot = makeSetupRobot({ exec: 'running' }); // running → stop step has real work
    var node = makeSetupNode(robot);
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true, JSON.stringify(msg.payload));
    assert.deepStrictEqual(msg.payload.steps.map(function(s) { return s.name; }), [
        'preflight', 'stop RAPID', 'unload conflicting module', 'upload MainModule.mod',
        'load module', 'reset program pointer', 'motors on', 'start RAPID', 'socket PING'
    ]);
    assert.ok(msg.payload.steps.every(function(s) { return s.ok; }));
    // sibling MainModuleEGM was loaded → unloaded before loadmod
    assert.ok(robot._st.calls.some(function(c) { return c.indexOf('unloadmod') >= 0 && c.indexOf('MainModuleEGM') >= 0; }));
    // uploaded content got SERVER_IP synced to the config node's IP
    assert.ok(robot._st.putBody.indexOf('"10.0.0.9"') >= 0);
    assert.ok(robot._st.calls.some(function(c) { return c.indexOf('loadmod') >= 0 && c.indexOf('replace%3Dtrue') >= 0 || c.indexOf('replace=true') >= 0; }));
    assert.ok(robot._st.calls.indexOf('POST /rw/rapid/execution/stop') >= 0);
    assert.ok(robot._st.calls.indexOf('POST /rw/panel/ctrl-state') >= 0);
    assert.ok(robot._st.calls.indexOf('POST /rw/rapid/execution/start') >= 0);
    assert.strictEqual(robot._st.calls[robot._st.calls.length - 1], 'SOCK PING');
});

await checkAsync('gofa-setup: not in Auto mode fails at preflight with no side effects', async function() {
    var robot = makeSetupRobot({ opmode: 'manualreduced' });
    var node = makeSetupNode(robot);
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(msg.payload.steps.length, 1);
    assert.strictEqual(msg.payload.steps[0].name, 'preflight');
    assert.ok(msg.payload.error.indexOf('Auto') >= 0);
    assert.strictEqual(robot._st.calls.filter(function(c) { return c.indexOf('POST') === 0 || c.indexOf('PUT') === 0; }).length, 0);
});

await checkAsync('gofa-setup: skips stop and unload when nothing to do', async function() {
    var robot = makeSetupRobot({ exec: 'stopped', modules: [{ name: 'MainModule', type: 'ProgMod' }] });
    var node = makeSetupNode(robot);
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.steps[1].detail, 'already stopped');
    assert.ok(msg.payload.steps[2].detail.indexOf('nothing to unload') === 0);
    assert.strictEqual(robot._st.calls.indexOf('POST /rw/rapid/execution/stop'), -1);
    assert.ok(!robot._st.calls.some(function(c) { return c.indexOf('unloadmod') >= 0; }));
});

await checkAsync('gofa-setup: dead socket fails the last step, earlier steps stay in report', async function() {
    var robot = makeSetupRobot({ pingOk: false });
    var node = makeSetupNode(robot);
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    var last = msg.payload.steps[msg.payload.steps.length - 1];
    assert.strictEqual(last.name, 'socket PING');
    assert.strictEqual(last.ok, false);
    assert.ok(last.detail.indexOf('SERVER_IP') >= 0);
    assert.strictEqual(msg.payload.steps.length, 9);
    assert.ok(msg.payload.steps.slice(0, 8).every(function(s) { return s.ok; }));
});

await checkAsync('gofa-setup: MainModuleEGM selection uploads/loads EGM module and unloads MainModule', async function() {
    var robot = makeSetupRobot({ modules: [{ name: 'MainModule', type: 'ProgMod' }] });
    var node = makeSetupNode(robot, { module: 'MainModuleEGM' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true, JSON.stringify(msg.payload));
    assert.ok(robot._st.calls.some(function(c) { return c.indexOf('unloadmod') >= 0 && c.indexOf('module=MainModule') >= 0; }));
    assert.ok(robot._st.calls.some(function(c) { return c.indexOf('PUT /fileservice/$HOME/Programs/MainModuleEGM.mod') === 0; }));
    assert.ok(robot._st.putBody.indexOf('"10.0.0.9"') >= 0);
});

await checkAsync('gofa-setup: no robot configured errors cleanly', async function() {
    var node = new (loadNodeType('./nodes/gofa-setup', { nodesById: {} }))({ robot: 'missing', outputPayload: true });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.strictEqual(node.errors.length, 1);
});

// NEW TESTS
await checkAsync('gofa-file: delete action returns 204 as ok:true, deleted:true', async function() {
    var calls = [];
    var mockRobot = { requestRaw: function(method, path) { calls.push(method, path); return Promise.resolve({ statusCode: 204 }); } };
    var node = new (loadNodeType('./nodes/gofa-file', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'delete', remotePath: 'test.txt' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(msg.payload.deleted, true);
    assert.strictEqual(msg.payload.remotePath, 'test.txt');
    assert.deepStrictEqual(calls, ['DELETE', '/fileservice/test.txt']);
});

await checkAsync('gofa-file: delete action returns 404 as ok:false, not found', async function() {
    var mockRobot = { requestRaw: function() { return Promise.resolve({ statusCode: 404 }); } };
    var node = new (loadNodeType('./nodes/gofa-file', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'delete' });
    var msg = {};
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, false);
    assert.ok(msg.payload.error.indexOf('File not found') >= 0);
});

await checkAsync('gofa-leadthrough: action override via msg.payload', async function() {
    var posts = [];
    var mockRobot = {
        socketSend: function() { return Promise.resolve('OK:'); },
        rwsPost: function(path, body) { posts.push(body); return Promise.resolve(''); },
        rwsGet: function() { return Promise.resolve('<span class="status">Inactive</span>'); },
        parseXhtml: parseXhtml
    };
    var node = new (loadNodeType('./nodes/gofa-leadthrough', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'enable' });
    var msg = { payload: 'disable' };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.deepStrictEqual(posts, ['status=inactive']);
});

await checkAsync('gofa-points: import still accepts a bare array payload', async function() {
    var mockRobot = { replacePoints: function(arr) { this._pts = arr; return arr; }, _savePoints: function(){} };
    var node = new (loadNodeType('./nodes/gofa-points', { nodesById: { r1: mockRobot } }))({ robot: 'r1', action: 'import' });
    var msg = { payload: [{id:'p1', name:'pt1'}] };
    await runInput(node, msg);
    assert.strictEqual(msg.payload.ok, true);
    assert.strictEqual(mockRobot._pts.length, 1);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);

})();

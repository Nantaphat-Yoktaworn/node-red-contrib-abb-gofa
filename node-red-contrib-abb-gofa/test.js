'use strict';
var assert = require('assert');
var robot  = require('./nodes/gofa-robot');
var gotoToken  = robot.gotoToken;
var parseXhtml = robot.parseXhtml;

var passed = 0, failed = 0;
function check(label, fn) {
    try { fn(); console.log('PASS ' + label); passed++; }
    catch(e) { console.error('FAIL ' + label + ' — ' + e.message); failed++; }
}

var sample = { x: 323.219, y: -81.812, z: 807.001,
               q1: 0.26714, q2: 0.12904, q3: 0.95361, q4: -0.05281,
               cf1: -1, cf4: -1, cf6: 0, cfx: 0 };

check('gotoToken: valid target produces GOTO string', function() {
    var tok = gotoToken(sample);
    assert.ok(tok.startsWith('GOTO'), 'should start with GOTO');
    assert.ok(tok.split(';').length === 11, 'should have 11 semicolon-separated values');
});

check('gotoToken: xyz rounds to 1 decimal place', function() {
    var tok = gotoToken(sample);
    var parts = tok.slice(4).split(';');
    assert.strictEqual(parts[0], '323.2');
    assert.strictEqual(parts[1], '-81.8');
    assert.strictEqual(parts[2], '807.0');
});

check('gotoToken: quaternion rounds to 4 decimal places', function() {
    var tok = gotoToken(sample);
    var parts = tok.slice(4).split(';');
    assert.strictEqual(parts[3], '0.2671');
    assert.strictEqual(parts[4], '0.1290');
    assert.strictEqual(parts[5], '0.9536');
    assert.strictEqual(parts[6], '-0.0528');
});

check('gotoToken: config flags are integers', function() {
    var tok = gotoToken(sample);
    var parts = tok.slice(4).split(';');
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

console.log('\n' + passed + ' passed, ' + failed + ' failed.');
if (failed) process.exit(1);

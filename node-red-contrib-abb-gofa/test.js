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

console.log('\n' + passed + ' passed, ' + failed + ' failed.');
if (failed) process.exit(1);

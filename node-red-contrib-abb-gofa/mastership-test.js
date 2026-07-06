'use strict';
// Standalone mastership-gated RWS test harness — no Node-RED runtime required.
// Wraps an arbitrary RWS POST in acquire-edit-mastership -> call -> release,
// all on one shared session (createRobotClient()'s withMastership()), so an
// ad-hoc live test of a mastership-gated endpoint (resetpp, loadmod, activate,
// a RAPID var write, ...) can't repeat two mistakes already hit and documented
// in this project's memory: forgetting Content-Type on the empty-body
// mastership request/release POSTs, and orphaning the lock by testing
// request/action/release as separate bare-auth curl calls with no shared
// cookie jar. Mastership is always released, even on failure (see
// withMastership() in nodes/gofa-robot.js).
//
// Usage:
//   node mastership-test.js <path> [body] [--hal]
// Examples:
//   node mastership-test.js /rw/rapid/execution/resetpp
//   node mastership-test.js /rw/rapid/tasks/T_ROB1/loadmod "modulepath=$HOME/Programs/MainModule.mod&replace=true" --hal
//   node mastership-test.js /rw/rapid/tasks/T_ROB1/activate "module=MainModule" --hal
//
// Git Bash / MSYS note: a leading "/rw/..." gets auto-rewritten into a Windows
// path (e.g. "C:/Program Files/Git/rw/...") before Node ever sees it — prefix
// the command with MSYS_NO_PATHCONV=1 to stop that.
var robot             = require('./nodes/gofa-robot');
var createRobotClient = robot.createRobotClient;

var argv  = process.argv.slice(2);
var flags = argv.filter(function(a) { return a.indexOf('--') === 0; });
var args  = argv.filter(function(a) { return a.indexOf('--') !== 0; });
var hal   = flags.indexOf('--hal') >= 0;

var urlPath = args[0];
var body    = args[1] || '';

if (!urlPath) {
    console.error('Usage: node mastership-test.js <path> [body] [--hal]');
    console.error('Example: node mastership-test.js /rw/rapid/tasks/T_ROB1/loadmod "modulepath=$HOME/Programs/MainModule.mod&replace=true" --hal');
    console.error('Git Bash: prefix with MSYS_NO_PATHCONV=1 or the leading "/" gets rewritten into a Windows path.');
    process.exit(1);
}

var cfg = {
    ip:         process.env.GOFA_IP         || '192.168.20.36',
    rwsPort:    parseInt(process.env.GOFA_RWS_PORT)    || 443,
    socketPort: parseInt(process.env.GOFA_SOCKET_PORT) || 1025,
    username:   process.env.GOFA_USERNAME   || 'NNNN',
    password:   process.env.GOFA_PASSWORD   || 'robotics'
};

var client = createRobotClient(cfg);

console.log('POST ' + urlPath + (body ? '  body=' + body : '') + (hal ? '  (Accept: hal+json)' : ''));
console.log('-> requesting edit mastership...');

client.withMastership(function() {
    console.log('-> mastership held, calling...');
    return hal ? client.rwsPostHal(urlPath, body) : client.rwsPost(urlPath, body);
}).then(function(result) {
    console.log('-> mastership released');
    console.log('OK');
    console.log(result);
    process.exit(0);
}).catch(function(err) {
    console.log('-> mastership released');
    console.error('FAILED: ' + err.message);
    process.exit(1);
});

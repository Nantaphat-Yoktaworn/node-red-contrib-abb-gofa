'use strict';
var gate = require('./lib/gate');
var fs   = require('fs');
var path = require('path');
var parseXhtml    = require('./gofa-robot').parseXhtml;
var PALETTE_VERSION = require('./gofa-robot').PALETTE_VERSION;
var parseLiSpans  = require('./gofa-rapid-tasks').parseLiSpans;
var patchServerIp = require('./lib/patch-server-ip');

// One-click first-run initialization: preflight → stop RAPID → unload the
// conflicting sibling module → upload the bundled .mod (SERVER_IP auto-synced
// to the config node's IP) → loadmod → resetpp → motors on → start (verified,
// HTTP 200 lies — same guard as gofa-rapid-exec) → socket PING. Assumes the
// RobotStudio-side setup (UAS grants, Auto mode switch access) is already done.
module.exports = function(RED) {
    function GoFaSetupNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.module = config.module || 'MainModule';
        this.task   = config.task   || 'T_ROB1';
        // ponytail: timings on the instance so tests can shrink them
        this._t = { poll: 300, stop: 5000, motoron: 8000, start: 3000, ping: 8000 };
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            if (node._running) { node.warn('setup already running — ignoring input'); return done(); }
            node._running = true;

            var r          = node.robot;
            var moduleName = node.module;
            var task       = node.task;
            var sibling    = moduleName === 'MainModule' ? 'MainModuleEGM' : 'MainModule';
            var remotePath = '$HOME/Programs/' + moduleName + '.mod';
            var localPath  = path.join(__dirname, '..', 'rapid', moduleName + '.mod');
            var steps      = [];
            var current    = null;

            function step(name, fn) {
                return function(prev) {
                    current = name;
                    node.status({ fill: 'blue', shape: 'dot', text: name + '…' });
                    return Promise.resolve(prev).then(fn).then(function(detail) {
                        steps.push({ name: name, ok: true, detail: detail || null });
                    });
                };
            }
            function readState(rwsPath, cls) {
                return r.rwsGet(rwsPath).then(function(b) { return parseXhtml(b, cls); });
            }
            function waitFor(readFn, want, timeoutMs, label) {
                var deadline = Date.now() + timeoutMs;
                function poll() {
                    return readFn().then(function(state) {
                        if (state === want) return state;
                        if (Date.now() >= deadline) throw new Error(label + ' did not reach "' + want + '" (still "' + state + '")');
                        return new Promise(function(res) { setTimeout(res, node._t.poll); }).then(poll);
                    });
                }
                return poll();
            }
            var readExec = function() { return readState('/rw/rapid/execution', 'ctrlexecstate'); };
            var readCtrl = function() { return readState('/rw/panel/ctrl-state', 'ctrlstate'); };

            Promise.resolve()
            .then(step('preflight', function() {
                return Promise.all([readState('/rw/panel/opmode', 'opmode'), readCtrl()]).then(function(res) {
                    // opmode is reported UPPERCASE live ("AUTO"), unlike ctrlstate/ctrlexecstate
                    if (String(res[0]).toLowerCase() !== 'auto') {
                        throw new Error('controller is in "' + res[0] + '" mode — switch it to Auto on the FlexPendant, then run setup again (RWS cannot change the operating mode)');
                    }
                    return 'opmode auto, motors ' + res[1];
                });
            }))
            .then(step('stop RAPID', function() {
                return readExec().then(function(state) {
                    if (state === 'stopped') return 'already stopped';
                    return r.rwsPost('/rw/rapid/execution/stop', 'stopmode=stop&usetsp=normal')
                        .then(function() { return waitFor(readExec, 'stopped', node._t.stop, 'RAPID'); })
                        .then(function() { return 'stopped'; });
                });
            }))
            .then(step('unload conflicting module', function() {
                return r.rwsGet('/rw/rapid/tasks/' + encodeURIComponent(task) + '/modules').then(function(body) {
                    var mods = parseLiSpans(body, 'rap-module-info-li', ['name', 'type']);
                    var names = mods.map(function(m) { return m.name; });
                    // Only the known MainModule/MainModuleEGM pair is auto-unloaded (both
                    // declare PROC main() — leaving both loaded breaks resetpp/start with
                    // "main ambiguous", confirmed live). Anything else is not ours to remove.
                    if (names.indexOf(sibling) < 0) return 'nothing to unload (loaded: ' + (names.join(', ') || 'none') + ')';
                    return r.withMastership(function() {
                        return r.rwsPostHal('/rw/rapid/tasks/' + task + '/unloadmod', 'module=' + encodeURIComponent(sibling));
                    }).then(function() { return 'unloaded ' + sibling; });
                });
            }))
            .then(step('upload ' + moduleName + '.mod', function() {
                var text;
                try { text = fs.readFileSync(localPath, 'utf8'); }
                catch (e) { throw new Error('bundled module file missing (' + localPath + '): ' + e.message); }
                var patched = patchServerIp(text, r.ip);
                return r.rwsPut('/fileservice/' + remotePath, Buffer.from(patched.text, 'utf8'), 'text/plain;v=2.0')
                    .then(function() { return Buffer.byteLength(patched.text) + 'B, SERVER_IP → ' + r.ip; });
            }))
            .then(step('load module', function() {
                return r.withMastership(function() {
                    return r.rwsPostHal('/rw/rapid/tasks/' + task + '/loadmod', 'modulepath=' + encodeURIComponent(remotePath) + '&replace=true');
                }).then(function(result) {
                    try { return 'loaded ' + JSON.parse(result).state[0].name; }
                    catch (e) { return 'loaded'; }
                });
            }))
            .then(step('reset program pointer', function() {
                return r.withMastership(function() {
                    return r.rwsPost('/rw/rapid/execution/resetpp', '');
                });
            }))
            .then(step('motors on', function() {
                return readCtrl().then(function(state) {
                    if (state === 'motoron') return 'already on';
                    if (state === 'guardstop' || state === 'emergencystop') {
                        throw new Error('motors are in ' + state + ' — release the protective/emergency stop first');
                    }
                    return r.rwsPost('/rw/panel/ctrl-state', 'ctrl-state=motoron')
                        .then(function() { return waitFor(readCtrl, 'motoron', node._t.motoron, 'ctrl-state'); })
                        .then(function() { return 'on'; });
                });
            }))
            .then(step('start RAPID', function() {
                return r.rwsPost('/rw/rapid/execution/start',
                    'regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false')
                .then(function() {
                    // RWS returns 200 even when the controller rejects the start — verify.
                    return waitFor(readExec, 'running', node._t.start, 'RAPID').catch(function(err) {
                        throw new Error(err.message + ' — check the controller event log (gofa-elog)');
                    });
                }).then(function() { return 'running'; });
            }))
            .then(step('socket PING', function() {
                var deadline = Date.now() + node._t.ping;
                function ping() {
                    return r.socketSend('PING').then(function(resp) {
                        if (resp === 'OK:PING') {
                            var ver = r.getLastPingVersion();
                            if (ver === null) return 'OK (module version unknown — this module predates the version-handshake feature)';
                            if (ver === PALETTE_VERSION) return 'OK (module v' + ver + ')';
                            return 'OK — WARNING: module reports v' + ver + ', palette expects v' + PALETTE_VERSION + ' — check node-red-contrib-abb-gofa/rapid/ is in sync with the root rapid/ copies (see CLAUDE.md), then re-run setup';
                        }
                        throw new Error('unexpected reply: ' + resp);
                    }).catch(function(err) {
                        if (Date.now() >= deadline) {
                            throw new Error('socket server not answering (' + err.message + ') — RAPID is running but the socket did not come up; check SERVER_IP in the module matches the robot\'s real IP');
                        }
                        return new Promise(function(res) { setTimeout(res, 500); }).then(ping);
                    });
                }
                return ping();
            }))
            .then(function() {
                node._running = false;
                msg.payload = { ok: true, module: moduleName, task: task, steps: steps };
                node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                send(msg); done();
            })
            .catch(function(err) {
                node._running = false;
                steps.push({ name: current, ok: false, detail: err.message });
                msg.payload = { ok: false, module: moduleName, task: task, steps: steps, error: current + ': ' + err.message };
                node.status({ fill: 'red', shape: 'ring', text: current + ' failed' });
                node.error(current + ': ' + err.message, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-setup', GoFaSetupNode);

    RED.httpAdmin.post('/gofa-setup/:id/start', RED.auth.needsPermission('gofa-setup.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot) {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var moduleName = req.body.module || 'MainModule';
        var task       = req.body.task || 'T_ROB1';
        var sibling    = moduleName === 'MainModule' ? 'MainModuleEGM' : 'MainModule';
        var remotePath = '$HOME/Programs/' + moduleName + '.mod';
        var localPath  = path.join(__dirname, '..', 'rapid', moduleName + '.mod');
        var steps      = [];
        var current    = null;
        var timings = { poll: 300, stop: 5000, motoron: 8000, start: 3000, ping: 8000 };

        function step(name, fn) {
            return function(prev) {
                current = name;
                return Promise.resolve(prev).then(fn).then(function(detail) {
                    steps.push({ name: name, ok: true, detail: detail || null });
                });
            };
        }
        function readState(rwsPath, cls) {
            return robot.rwsGet(rwsPath).then(function(b) { return parseXhtml(b, cls); });
        }
        function waitFor(readFn, want, timeoutMs, label) {
            var deadline = Date.now() + timeoutMs;
            function poll() {
                return readFn().then(function(state) {
                    if (state === want) return state;
                    if (Date.now() >= deadline) throw new Error(label + ' did not reach "' + want + '" (still "' + state + '")');
                    return new Promise(function(res) { setTimeout(res, timings.poll); }).then(poll);
                });
            }
            return poll();
        }
        var readExec = function() { return readState('/rw/rapid/execution', 'ctrlexecstate'); };
        var readCtrl = function() { return readState('/rw/panel/ctrl-state', 'ctrlstate'); };

        Promise.resolve()
        .then(step('preflight', function() {
            return Promise.all([readState('/rw/panel/opmode', 'opmode'), readCtrl()]).then(function(res) {
                if (String(res[0]).toLowerCase() !== 'auto') {
                    throw new Error('controller is in "' + res[0] + '" mode — switch it to Auto on the FlexPendant, then run setup again (RWS cannot change the operating mode)');
                }
                return 'opmode auto, motors ' + res[1];
            });
        }))
        .then(step('stop RAPID', function() {
            return readExec().then(function(state) {
                if (state === 'stopped') return 'already stopped';
                return robot.rwsPost('/rw/rapid/execution/stop', 'stopmode=stop&usetsp=normal')
                    .then(function() { return waitFor(readExec, 'stopped', timings.stop, 'RAPID'); })
                    .then(function() { return 'stopped'; });
            });
        }))
        .then(step('unload conflicting module', function() {
            return robot.rwsGet('/rw/rapid/tasks/' + encodeURIComponent(task) + '/modules').then(function(body) {
                var mods = parseLiSpans(body, 'rap-module-info-li', ['name', 'type']);
                var names = mods.map(function(m) { return m.name; });
                if (names.indexOf(sibling) < 0) return 'nothing to unload (loaded: ' + (names.join(', ') || 'none') + ')';
                return robot.withMastership(function() {
                    return robot.rwsPostHal('/rw/rapid/tasks/' + task + '/unloadmod', 'module=' + encodeURIComponent(sibling));
                }).then(function() { return 'unloaded ' + sibling; });
            });
        }))
        .then(step('upload ' + moduleName + '.mod', function() {
            var text;
            try { text = fs.readFileSync(localPath, 'utf8'); }
            catch (e) { throw new Error('bundled module file missing (' + localPath + '): ' + e.message); }
            var patched = patchServerIp(text, robot.ip);
            return robot.rwsPut('/fileservice/' + remotePath, Buffer.from(patched.text, 'utf8'), 'text/plain;v=2.0')
                .then(function() { return Buffer.byteLength(patched.text) + 'B, SERVER_IP → ' + robot.ip; });
        }))
        .then(step('load module', function() {
            return robot.withMastership(function() {
                return robot.rwsPostHal('/rw/rapid/tasks/' + task + '/loadmod', 'modulepath=' + encodeURIComponent(remotePath) + '&replace=true');
            }).then(function(result) {
                try { return 'loaded ' + JSON.parse(result).state[0].name; }
                catch (e) { return 'loaded'; }
            });
        }))
        .then(step('reset program pointer', function() {
            return robot.withMastership(function() {
                return robot.rwsPost('/rw/rapid/execution/resetpp', '');
            });
        }))
        .then(step('motors on', function() {
            return readCtrl().then(function(state) {
                if (state === 'motoron') return 'already on';
                if (state === 'emergencystop' || state === 'guardstop') {
                    throw new Error('motors are in ' + state + ' — release the protective/emergency stop first');
                }
                return robot.rwsPost('/rw/panel/ctrl-state', 'ctrl-state=motoron')
                    .then(function() { return waitFor(readCtrl, 'motoron', timings.motoron, 'ctrl-state'); })
                    .then(function() { return 'on'; });
            });
        }))
        .then(step('start RAPID', function() {
            return robot.rwsPost('/rw/rapid/execution/start',
                'regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false')
            .then(function() {
                return waitFor(readExec, 'running', timings.start, 'RAPID').catch(function(err) {
                    throw new Error(err.message + ' — check the controller event log (gofa-elog)');
                });
            }).then(function() { return 'running'; });
        }))
        .then(step('socket PING', function() {
            var deadline = Date.now() + timings.ping;
            function ping() {
                return robot.socketSend('PING').then(function(resp) {
                    if (resp === 'OK:PING') {
                        var ver = robot.getLastPingVersion();
                        if (ver === null) return 'OK (module version unknown — this module predates the version-handshake feature)';
                        if (ver === PALETTE_VERSION) return 'OK (module v' + ver + ')';
                        return 'OK — WARNING: module reports v' + ver + ', palette expects v' + PALETTE_VERSION + ' — check node-red-contrib-abb-gofa/rapid/ is in sync with the root rapid/ copies (see CLAUDE.md), then re-run setup';
                    }
                    throw new Error('unexpected reply: ' + resp);
                }).catch(function(err) {
                    if (Date.now() >= deadline) {
                        throw new Error('socket server not answering (' + err.message + ') — RAPID is running but the socket did not come up; check SERVER_IP in the module matches the robot\'s real IP');
                    }
                    return new Promise(function(res) { setTimeout(res, 500); }).then(ping);
                });
            }
            return ping();
        }))
        .then(function() {
            res.json({ ok: true, module: moduleName, task: task, steps: steps });
        })
        .catch(function(err) {
            steps.push({ name: current, ok: false, detail: err.message });
            res.status(502).json({ ok: false, module: moduleName, task: task, steps: steps, error: current + ': ' + err.message });
        });
    });
};

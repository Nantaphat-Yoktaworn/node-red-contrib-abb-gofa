'use strict';
module.exports = function(RED) {
    function GoFaRapidExecNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.action = config.action || 'start';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var raw    = msg.payload;
            var action = (typeof raw === 'string' && raw) ? raw
                       : (raw && raw.action)              ? raw.action
                       : node.action;
            node.status({ fill: 'blue', shape: 'dot', text: action });

            var bodies = {
                start:   'regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false',
                stop:    'stopmode=stop&usetsp=normal',
                resetpp: ''
            };

            var labels = { start: 'running', stop: 'stopped', resetpp: 'PP reset' };

            if (!bodies.hasOwnProperty(action)) {
                msg.payload = { ok: false, error: 'Unknown action: ' + action + ' (use start, stop, or resetpp)' };
                node.error('Unknown action: ' + action + ' (use start, stop, or resetpp)', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad action' });
                send(msg); return done();
            }

            var r = node.robot;

            // RWS accepts POST /rw/rapid/execution/start with HTTP 200 even when the
            // controller then immediately rejects it (e.g. RAPID error 20055 — program
            // must start in Motor On state). The HTTP response alone can't tell us that,
            // so for 'start' we check ctrl-state first (fails fast with a clear reason)
            // and then poll execution state after the POST to confirm it actually ran.
            function readCtrlState() {
                return r.rwsGet('/rw/panel/ctrl-state').then(function(body) {
                    return r.parseXhtml(body, 'ctrlstate');
                });
            }
            function readExecState() {
                return r.rwsGet('/rw/rapid/execution').then(function(body) {
                    return r.parseXhtml(body, 'ctrlexecstate');
                });
            }
            function waitForExecState(want, timeoutMs) {
                var deadline = Date.now() + timeoutMs;
                function poll() {
                    return readExecState().then(function(state) {
                        if (state === want) return state;
                        if (Date.now() >= deadline) {
                            var err = new Error('RAPID did not reach "' + want + '" (still "' + state + '")');
                            err.execstate = state;
                            throw err;
                        }
                        return new Promise(function(res) { setTimeout(res, 300); }).then(poll);
                    });
                }
                return poll();
            }

            var doAction;
            if (action === 'start') {
                doAction = readCtrlState().then(function(ctrlstate) {
                    if (ctrlstate !== 'motoron') {
                        var err = new Error('Cannot start RAPID: motors are ' + (ctrlstate || 'off') + ' — turn Motors On first');
                        err.ctrlstate = ctrlstate;
                        throw err;
                    }
                    return r.rwsPost('/rw/rapid/execution/start', bodies.start);
                }).then(function() {
                    return waitForExecState('running', 1500).catch(function(err) {
                        // POST succeeded but RAPID never actually entered 'running' — re-check
                        // ctrl-state for a more specific reason (e.g. motors tripped off mid-request)
                        return readCtrlState().then(function(cs) {
                            var reason = cs !== 'motoron' ? ' (motors are ' + cs + ')' : '';
                            var e2 = new Error('RAPID did not start' + reason + ' — check the controller event log (gofa-elog)');
                            e2.execstate = err.execstate;
                            e2.ctrlstate = cs;
                            throw e2;
                        });
                    });
                });
            } else if (action === 'resetpp') {
                // resetpp requires edit mastership (/rw/mastership/edit/request).
                doAction = node.robot.withMastership(function() {
                    return node.robot.rwsPost('/rw/rapid/execution/resetpp', '');
                });
            } else {
                // stop works without mastership given Remote Start/Stop UAS grant.
                doAction = node.robot.rwsPost('/rw/rapid/execution/' + action, bodies[action]);
            }

            doAction.then(function() {
                msg.payload = { ok: true, action: action };
                node.status({ fill: 'green', shape: 'dot', text: labels[action] });
                send(msg); done();
            })
            .catch(function(err) {
                var hint = '';
                if (err.message.indexOf('-757') >= 0 || err.message.indexOf('not allowed access') >= 0) {
                    hint = ' (requires Remote Start/Stop grant — RobotStudio → Edit User Accounts)';
                }
                msg.payload = { ok: false, error: err.message + hint, action: action };
                if (err.ctrlstate !== undefined) msg.payload.ctrlstate = err.ctrlstate;
                if (err.execstate !== undefined) msg.payload.execstate = err.execstate;
                node.status({ fill: 'red', shape: 'ring', text: (err.ctrlstate && err.ctrlstate !== 'motoron') ? 'motors ' + err.ctrlstate : 'error' });
                node.error(err.message + hint, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-rapid-exec', GoFaRapidExecNode);
};

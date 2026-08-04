'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');

var BODIES = {
    start:     'regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false',
    stop:      'stopmode=stop&usetsp=normal',
    resetpp:   '',
    loadmod:   '',
    unloadmod: '',
    activate:  ''
};
var LABELS = { start: 'running', stop: 'stopped', resetpp: 'PP reset',
               loadmod: 'module loaded', unloadmod: 'module unloaded', activate: 'module activated' };

// C1 (2026-08-04): one implementation of the action chain, shared by the runtime
// node and the editor-panel route. These were two ~110-line copies — the same
// duplication that let bug 2 (version comparison) and bug 3 (path escaping) each
// get fixed in only one of their two places.
//
// Resolves { ok:true, action, ... }; rejects with an Error carrying .ctrlstate /
// .execstate when controller state is the reason it failed.
function execRapidAction(robot, opts) {
    var action     = opts.action;
    var task       = opts.task;
    var modulePath = opts.modulePath;
    var replace    = opts.replace;
    var moduleName = opts.moduleName;

    function readCtrlState() {
        return robot.rwsGet('/rw/panel/ctrl-state').then(function(body) {
            return robot.parseXhtml(body, 'ctrlstate');
        });
    }
    function readExecState() {
        return robot.rwsGet('/rw/rapid/execution').then(function(body) {
            return robot.parseXhtml(body, 'ctrlexecstate');
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
        // RWS accepts POST /rw/rapid/execution/start with HTTP 200 even when the
        // controller immediately rejects it (e.g. RAPID error 20055 — program must
        // start in Motor On state). Check ctrl-state first, then poll to confirm.
        doAction = readCtrlState().then(function(ctrlstate) {
            if (ctrlstate !== 'motoron') {
                var err = new Error('Cannot start RAPID: motors are ' + (ctrlstate || 'off') + ' — turn Motors On first');
                err.ctrlstate = ctrlstate;
                throw err;
            }
            return robot.rwsPost('/rw/rapid/execution/start', BODIES.start);
        }).then(function() {
            return waitForExecState('running', 1500).catch(function(err) {
                // POST succeeded but RAPID never entered 'running' — re-check
                // ctrl-state for a more specific reason (motors tripped off mid-request).
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
        doAction = robot.withMastership(function() {
            return robot.rwsPost('/rw/rapid/execution/resetpp', '');
        });
    } else if (action === 'loadmod' || action === 'unloadmod' || action === 'activate') {
        // All three need edit mastership and hal+json (not xhtml+xml — confirmed
        // live), and all three require RAPID stopped first (HTTP 403 with "PGM
        // state" while running). Checked proactively for a fast, clear error
        // instead of a round trip that was always going to fail.
        doAction = readExecState().then(function(execstate) {
            if (execstate !== 'stopped') {
                var err = new Error('Cannot ' + action + ': RAPID is ' + execstate +
                    ' — stop it first (e.g. gofa-rapid-exec action "stop")');
                err.execstate = execstate;
                throw err;
            }
            var taskPath = '/rw/rapid/tasks/' + encodeURIComponent(task);
            if (action === 'loadmod') {
                var body = 'modulepath=' + encodeURIComponent(modulePath) + '&replace=' + (replace ? 'true' : 'false');
                return robot.withMastership(function() { return robot.rwsPostHal(taskPath + '/loadmod', body); });
            }
            // unloadmod removes the named module from this task ONLY (the .mod file
            // stays on the controller's disk). Needed before loadmod-ing a
            // differently-named module: replace=true only replaces a module with the
            // SAME name, so loading MainModuleEGM while MainModule is still loaded
            // leaves both loaded and RAPID rejects resetpp/start with "Global routine
            // name main ambiguous" (both declare PROC main()) — confirmed live.
            // activate makes the named module the task's active/bound one (204 on success).
            var b = 'module=' + encodeURIComponent(moduleName);
            var suffix = action === 'unloadmod' ? '/unloadmod' : '/activate';
            return robot.withMastership(function() { return robot.rwsPostHal(taskPath + suffix, b); });
        });
    } else {
        // stop works without mastership given the Remote Start/Stop UAS grant.
        doAction = robot.rwsPost('/rw/rapid/execution/' + action, BODIES[action]);
    }

    return doAction.then(function(result) {
        var out = { ok: true, action: action };
        if (action === 'loadmod') {
            out.task = task;
            out.modulePath = modulePath;
            try {
                var loaded = JSON.parse(result).state[0];
                out.module = loaded && loaded.name;
            } catch (e) { /* leave module unset if the response shape ever changes */ }
        } else if (action === 'activate' || action === 'unloadmod') {
            out.task = task;
            out.module = moduleName;
        }
        return out;
    });
}

// Shared remedy text for the two failure modes that have a specific fix.
function actionErrorHint(action, err) {
    if (err.message.indexOf('-757') >= 0 || err.message.indexOf('not allowed access') >= 0) {
        return ' (requires Remote Start/Stop grant — RobotStudio → Edit User Accounts)';
    }
    if ((action === 'loadmod' || action === 'unloadmod' || action === 'activate') &&
        err.message.indexOf('PGM state') >= 0) {
        return ' (RAPID must be stopped for ' + action + ' — stop it first, e.g. gofa-rapid-exec action "stop")';
    }
    return '';
}

module.exports = function(RED) {
    function GoFaRapidExecNode(config) {
        RED.nodes.createNode(this, config);
        this.robot      = RED.nodes.getNode(config.robot);
        this.action     = config.action     || 'start';
        this.task       = config.task       || 'T_ROB1';
        this.modulePath = config.modulePath || '$HOME/Programs/MainModule.mod';
        this.replace    = config.replace    !== false;
        this.module     = config.module     || 'MainModule';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var raw    = msg.payload;
            var action = (typeof raw === 'string' && raw) ? raw
                       : (raw && raw.action)              ? raw.action
                       : node.action;
            var opts = {
                action:     action,
                task:       (raw && raw.task)                  ? raw.task       : node.task,
                modulePath: (raw && raw.modulePath)            ? raw.modulePath : node.modulePath,
                replace:    (raw && raw.replace !== undefined) ? !!raw.replace  : node.replace,
                moduleName: (raw && raw.module)                ? raw.module     : node.module
            };
            node.status({ fill: 'blue', shape: 'dot', text: action });

            // Chaining hazard: this node's own success output is {ok:true, action:<...>},
            // exactly the shape the msg.payload.action override reads from — wiring one
            // gofa-rapid-exec node straight into another silently repeats the first
            // node's action instead of running the second node's configured one. Warn
            // (don't block — the override itself is a deliberate, useful feature).
            if (raw && typeof raw === 'object' && raw.ok !== undefined && raw.action !== undefined) {
                node.warn('msg.payload looks like another gofa-rapid-exec node\'s own output ({ok, action}) — ' +
                    'if unintentional, insert a change node to clear msg.payload between chained ' +
                    'gofa-rapid-exec nodes; action "' + raw.action + '" is currently overriding this node\'s configured action');
            }

            if (!BODIES.hasOwnProperty(action)) {
                var m = 'Unknown action: ' + action + ' (use start, stop, resetpp, loadmod, unloadmod, or activate)';
                msg.payload = { ok: false, error: m };
                node.error(m, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad action' });
                send(msg); return done();
            }

            execRapidAction(node.robot, opts).then(function(out) {
                msg.payload = out;
                node.status({ fill: 'green', shape: 'dot', text: LABELS[action] });
                send(msg); done();
            }).catch(function(err) {
                var hint = actionErrorHint(action, err);
                msg.payload = { ok: false, error: err.message + hint, action: action };
                if (err.ctrlstate !== undefined) msg.payload.ctrlstate = err.ctrlstate;
                if (err.execstate !== undefined) msg.payload.execstate = err.execstate;
                node.status({ fill: 'red', shape: 'ring',
                    text: (err.ctrlstate && err.ctrlstate !== 'motoron') ? 'motors ' + err.ctrlstate : 'error' });
                node.error(err.message + hint, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-rapid-exec', GoFaRapidExecNode);

    RED.httpAdmin.get('/gofa-rapid-exec/:id/read', RED.auth.needsPermission('gofa-rapid-exec.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        Promise.all([
            robot.rwsGet('/rw/panel/ctrl-state'),
            robot.rwsGet('/rw/rapid/execution')
        ]).then(function(b) {
            res.json({
                ok: true,
                ctrlstate: robot.parseXhtml(b[0], 'ctrlstate'),
                execstate: robot.parseXhtml(b[1], 'ctrlexecstate')
            });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });

    RED.httpAdmin.post('/gofa-rapid-exec/:id/action', requireAdminAuth(RED, 'gofa-rapid-exec.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsPost !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var action = req.body.action || 'start';
        if (!BODIES.hasOwnProperty(action)) {
            return res.status(400).json({ error: 'Unknown action: ' + action });
        }
        execRapidAction(robot, {
            action:     action,
            task:       req.body.task       || 'T_ROB1',
            modulePath: req.body.modulePath || '$HOME/Programs/MainModule.mod',
            replace:    req.body.replace    !== false,
            moduleName: req.body.module     || 'MainModule'
        }).then(function(out) {
            res.json(out);
        }).catch(function(err) {
            res.status(502).json({ error: err.message + actionErrorHint(action, err),
                                   ctrlstate: err.ctrlstate, execstate: err.execstate });
        });
    });
};

module.exports.execRapidAction = execRapidAction;
module.exports.actionErrorHint = actionErrorHint;

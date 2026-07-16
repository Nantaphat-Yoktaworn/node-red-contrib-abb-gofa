'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaRapidVarReadNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.task     = config.task     || 'T_ROB1';
        this.module   = config.module   || 'MainModule';
        this.variable = config.variable || '';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var task     = (msg.payload && msg.payload.task)     || node.task;
            var module   = (msg.payload && msg.payload.module)   || node.module;
            var variable = (msg.payload && msg.payload.variable) || node.variable;

            if (!variable) {
                msg.payload = { ok: false, error: 'No variable name specified' };
                node.error('No variable name specified', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'no variable' });
                send(msg); return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: variable });

            // Primary: use TCP socket GETVAR command — proven and simple. RWS's generic
            // symbol endpoint is a possible alternative but its OmniCore call syntax isn't
            // fully worked out yet (see abb-rws skill); this isn't a licensing workaround.
            node.robot.socketSend({ cmd: 'getvar', name: variable })
            .then(function(reply) {
                // reply is "VAL:<value>" or "ERR:<reason>"
                if (reply.startsWith('VAL:')) {
                    var rawVal = reply.slice(4);
                    // Try to parse as number; keep as string if not numeric
                    var numVal = parseFloat(rawVal);
                    var value = isNaN(numVal) ? rawVal : numVal;
                    msg.payload = { ok: true, variable: variable, value: value, source: 'socket' };
                    node.status({ fill: 'green', shape: 'dot', text: variable + ' = ' + value });
                    send(msg); done();
                } else {
                    // ERR:UNKNOWN_VAR means the variable isn't in the RAPID GETVAR handler
                    throw new Error(reply);
                }
            })
            .catch(function(err) {
                if (err && err.message && err.message.startsWith('ERR:')) {
                    // Fallback: read the module source from the controller filesystem and parse :=
                    var textPath = '/rw/rapid/tasks/' +
                        encodeURIComponent(task) + '/modules/' +
                        encodeURIComponent(module) + '/text';

                    node.robot.rwsGet(textPath)
                    .then(function(metaBody) {
                        var filePath = node.robot.parseXhtml(metaBody, 'file-path');
                        if (!filePath) throw new Error('Cannot locate module source for ' + module);
                        return node.robot.rwsGet('/fileservice/' + filePath);
                    })
                    .then(function(src) {
                        var esc = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        var re  = new RegExp('\\b' + esc + '\\s*:=\\s*([^;]+);', 'i');
                        var m   = src.match(re);
                        if (!m) {
                            throw new Error('Variable ' + variable + ' not found in module ' + module +
                                ' — add it to the GETVAR handler in MainModule.mod for live value access');
                        }
                        var value = m[1].trim().replace(/^"(.*)"$/, '$1');
                        // Confirmed live against the real controller: this text export reflects the
                        // module's compiled/declared value, not the variable's current runtime value
                        // (write via SETVAR, re-read here, and you'll still see the old value). Flag
                        // it rather than presenting it with the same confidence as a live socket read.
                        msg.payload = { ok: true, variable: variable, value: value, source: 'module-text', stale: true,
                            warning: 'value is the compiled/declared value, not necessarily the live current value — add this variable to GETVAR in MainModule.mod for a live read' };
                        node.status({ fill: 'yellow', shape: 'ring', text: variable + ' = ' + value + ' (stale?)' });
                        send(msg); done();
                    })
                    .catch(function(err2) {
                        msg.payload = { ok: false, error: err2.message };
                        node.status({ fill: 'red', shape: 'ring', text: 'error' });
                        node.error(err2.message, msg);
                        send(msg); done(err2);
                    });
                } else {
                    var errMsg = (err && err.message) || 'Unknown socket error';
                    msg.payload = { ok: false, error: errMsg };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(errMsg, msg);
                    send(msg); done(err);
                }
            });
        });
    }
    RED.nodes.registerType('gofa-rapid-var-read', GoFaRapidVarReadNode);

    RED.httpAdmin.get('/gofa-rapid-var-read/:id/read', RED.auth.needsPermission('gofa-rapid-var-read.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot) {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var task = req.query.task || 'T_ROB1';
        var moduleName = req.query.module || 'MainModule';
        var variable = req.query.variable;

        if (!variable) {
            return res.status(400).json({ error: 'No variable name specified' });
        }

        if (typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }

        robot.socketSend({ cmd: 'getvar', name: variable })
        .then(function(reply) {
            if (reply.startsWith('VAL:')) {
                var rawVal = reply.slice(4);
                var numVal = parseFloat(rawVal);
                var value = isNaN(numVal) ? rawVal : numVal;
                res.json({ ok: true, variable: variable, value: value, source: 'socket' });
            } else {
                throw new Error(reply);
            }
        })
        .catch(function(err) {
            if (err && err.message && err.message.startsWith('ERR:')) {
                var textPath = '/rw/rapid/tasks/' +
                    encodeURIComponent(task) + '/modules/' +
                    encodeURIComponent(moduleName) + '/text';

                robot.rwsGet(textPath)
                .then(function(metaBody) {
                    var filePath = robot.parseXhtml(metaBody, 'file-path');
                    if (!filePath) throw new Error('Cannot locate module source for ' + moduleName);
                    return robot.rwsGet('/fileservice/' + filePath);
                })
                .then(function(src) {
                    var esc = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    var re  = new RegExp('\\b' + esc + '\\s*:=\\s*([^;]+);', 'i');
                    var m   = src.match(re);
                    if (!m) {
                        throw new Error('Variable ' + variable + ' not found in module ' + moduleName +
                            ' — add it to the GETVAR handler in MainModule.mod for live value access');
                    }
                    var value = m[1].trim().replace(/^"(.*)"$/, '$1');
                    res.json({
                        ok: true,
                        variable: variable,
                        value: value,
                        source: 'module-text',
                        stale: true,
                        warning: 'value is the compiled/declared value, not necessarily the live current value'
                    });
                })
                .catch(function(err2) {
                    res.status(502).json({ error: err2.message });
                });
            } else {
                res.status(502).json({ error: err.message || 'Unknown error' });
            }
        });
    });
};

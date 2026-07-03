'use strict';
module.exports = function(RED) {
    function GoFaSubscribeVarNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.task     = config.task     || 'T_ROB1';
        this.module   = config.module   || 'MainModule';
        this.variable = config.variable || '';
        this.interval = parseInt(config.interval) || 1000;
        var node = this;
        node._timer   = null;
        node._polling = false;

        // RWS's generic /rw/rapid/symbol/data/RAPID/{task}/{module}/{name} (RWS 1.0 shape)
        // is confirmed to always 404 on OmniCore — it advertises a different, plural,
        // search-based /rw/rapid/symbols resource instead (see abb-rws skill). Reading the
        // module's current text via the fileservice and regex-matching the variable is the
        // only path that actually works on this hardware, so it's the only one attempted.
        //
        // Confirmed live against the real controller that this path is STALE: it reflects the
        // module's compiled/declared value, not the variable's current runtime value (write via
        // SETVAR, poll here, and you'll still see the old value). There is currently no working
        // RWS path to a live value for variables outside the GETVAR allow-list, so this is
        // reported with a `stale: true` flag rather than silently presented as current.
        function readVar(task, module, variable, cb) {
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
                    cb(new Error('Variable ' + variable + ' not found in module ' + module));
                    return;
                }
                var value = m[1].trim().replace(/^"(.*)"$/, '$1');
                cb(null, value, 'module-text');
            })
            .catch(function(err) { cb(err); });
        }

        function startPolling(task, module, variable) {
            if (!node.robot) { node.error('No robot configured'); return; }
            if (!variable) {
                node.error('Variable must be specified');
                node.status({ fill: 'red', shape: 'ring', text: 'no variable' });
                return;
            }

            node._polling = true;
            node.status({ fill: 'yellow', shape: 'ring', text: variable + ' polling' });

            function poll() {
                if (!node._polling) return;
                readVar(task, module, variable, function(err, value, source) {
                    if (!node._polling) return;
                    if (err) {
                        node.status({ fill: 'red', shape: 'ring', text: 'error' });
                        node.error(err.message);
                    } else {
                        node.status({ fill: 'yellow', shape: 'dot', text: variable + '=' + value + ' (stale?)' });
                        node.send({ payload: { ok: true, task: task, module: module, variable: variable, value: value, source: source, stale: true,
                            warning: 'value is the compiled/declared value, not necessarily the live current value — add this variable to GETVAR in MainModule.mod for a live read' } });
                    }
                    if (node._polling) {
                        node._timer = setTimeout(poll, node.interval);
                    }
                });
            }

            poll();
        }

        function stopPolling() {
            node._polling = false;
            if (node._timer) { clearTimeout(node._timer); node._timer = null; }
            node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
        }

        node.on('input', function(msg, send, done) {
            var task     = (msg.payload && msg.payload.task)     || node.task;
            var module   = (msg.payload && msg.payload.module)   || node.module;
            var variable = (msg.payload && msg.payload.variable) || node.variable;

            if (node._polling) {
                stopPolling();
            } else {
                startPolling(task, module, variable);
            }
            done();
        });

        node.on('close', function(done) {
            stopPolling();
            done();
        });
    }
    RED.nodes.registerType('gofa-subscribe-var', GoFaSubscribeVarNode);
};

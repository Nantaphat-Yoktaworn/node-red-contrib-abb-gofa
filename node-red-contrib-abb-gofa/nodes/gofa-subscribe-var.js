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

        function readVar(task, module, variable, cb) {
            var symPath = '/rw/rapid/symbol/data/RAPID/' +
                encodeURIComponent(task) + '/' +
                encodeURIComponent(module) + '/' +
                encodeURIComponent(variable);

            node.robot.rwsGet(symPath)
            .then(function(body) {
                var value = node.robot.parseXhtml(body, 'value');
                cb(null, value, 'rws');
            })
            .catch(function() {
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
                .catch(function(err2) { cb(err2); });
            });
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
                        node.status({ fill: 'green', shape: 'dot', text: variable + '=' + value });
                        node.send({ payload: { ok: true, task: task, module: module, variable: variable, value: value, source: source } });
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

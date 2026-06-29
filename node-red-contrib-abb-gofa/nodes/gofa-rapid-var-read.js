'use strict';
module.exports = function(RED) {
    function GoFaRapidVarReadNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.task     = config.task     || 'T_ROB1';
        this.module   = config.module   || 'MainModule';
        this.variable = config.variable || '';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var task     = (msg.payload && msg.payload.task)     || node.task;
            var module   = (msg.payload && msg.payload.module)   || node.module;
            var variable = (msg.payload && msg.payload.variable) || node.variable;

            if (!variable) {
                node.error('No variable name specified', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'no variable' });
                return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: variable });

            var symPath = '/rw/rapid/symbol/data/RAPID/' +
                encodeURIComponent(task) + '/' +
                encodeURIComponent(module) + '/' +
                encodeURIComponent(variable);

            node.robot.rwsGet(symPath)
            .then(function(body) {
                var value = node.robot.parseXhtml(body, 'value');
                msg.payload = { ok: true, variable: variable, value: value, raw: body, source: 'rws' };
                node.status({ fill: 'green', shape: 'dot', text: variable + ' = ' + value });
                send(msg); done();
            })
            .catch(function() {
                // PC Interface not installed — fall back via module-text metadata → fileservice
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
                            ' (runtime VAR changes require PC Interface; PERS values reflect last loaded module)');
                    }
                    var value = m[1].trim().replace(/^"(.*)"$/, '$1');
                    msg.payload = { ok: true, variable: variable, value: value, source: 'module-text' };
                    node.status({ fill: 'green', shape: 'dot', text: variable + ' = ' + value });
                    send(msg); done();
                })
                .catch(function(err2) {
                    msg.payload = { ok: false, error: err2.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err2.message, msg); done(err2);
                });
            });
        });
    }
    RED.nodes.registerType('gofa-rapid-var-read', GoFaRapidVarReadNode);
};

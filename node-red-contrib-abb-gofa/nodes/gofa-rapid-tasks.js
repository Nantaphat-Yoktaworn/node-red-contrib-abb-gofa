'use strict';
var gate = require('./lib/gate');
var TASK_FIELDS   = ['name', 'type', 'taskstate', 'excstate', 'active', 'motiontask'];
var MODULE_FIELDS = ['name', 'type'];

// Extracts one object per <li class="{liClass}...">...</li> block, pulling
// out only the given field classes. Same two-pass li/span approach as
// gofa-elog.js — parseXhtml() only returns the first match in the whole
// body, which isn't enough when a response lists multiple tasks/modules.
function parseLiSpans(body, liClass, fields) {
    var items = [];
    var liRe = new RegExp('<li class="' + liClass + '[^"]*"[^>]*>([\\s\\S]*?)<\\/li>', 'g');
    var li;
    while ((li = liRe.exec(body)) !== null) {
        var item = {};
        var spanRe = /class="([^"]+)">([^<]*)</g;
        var span;
        while ((span = spanRe.exec(li[1])) !== null) {
            var cls = span[1].trim();
            if (fields.indexOf(cls) >= 0) item[cls] = span[2].trim();
        }
        if (Object.keys(item).length) items.push(item);
    }
    return items;
}

module.exports = function(RED) {
    function GoFaRapidTasksNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.task  = config.task || 'T_ROB1';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var r = node.robot;
            var task = (msg.payload && msg.payload.task) || node.task;

            node.status({ fill: 'blue', shape: 'dot', text: 'reading...' });

            Promise.all([
                r.rwsGet('/rw/rapid/tasks'),
                r.rwsGet('/rw/rapid/tasks/' + encodeURIComponent(task) + '/modules')
            ]).then(function(b) {
                var tasks   = parseLiSpans(b[0], 'rap-task-li', TASK_FIELDS);
                var modules = parseLiSpans(b[1], 'rap-module-info-li', MODULE_FIELDS);
                msg.payload = { ok: true, tasks: tasks, task: task, modules: modules };
                node.status({ fill: 'green', shape: 'dot', text: tasks.length + ' tasks, ' + modules.length + ' modules' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-rapid-tasks', GoFaRapidTasksNode);
};

module.exports.parseLiSpans = parseLiSpans;

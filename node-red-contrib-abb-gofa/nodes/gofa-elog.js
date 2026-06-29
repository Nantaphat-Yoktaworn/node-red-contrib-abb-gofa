'use strict';
module.exports = function(RED) {
    function GoFaElogNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.domain = config.domain || '1';
        this.count  = parseInt(config.count) || 10;
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var opts = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
            var domain = opts.domain !== undefined ? String(opts.domain) : node.domain;
            var count  = Math.min(parseInt(opts.count) || node.count, 100);

            node.status({ fill: 'blue', shape: 'dot', text: 'reading...' });

            node.robot.rwsGet('/rw/elog/' + encodeURIComponent(domain) + '?lang=en&lim=' + count)
            .then(function(body) {
                var entries = [];
                var liRe = /<li class="elog-message-li"[^>]*>([\s\S]*?)<\/li>/g;
                var spanRe = /class="([^"]+)">([^<]*)</g;
                var fields = ['seqnum', 'msgtype', 'code', 'title', 'tstamp'];
                var li;
                while ((li = liRe.exec(body)) !== null) {
                    var entry = {};
                    var span;
                    while ((span = spanRe.exec(li[1])) !== null) {
                        var cls = span[1].trim();
                        if (fields.indexOf(cls) >= 0) entry[cls] = span[2].trim();
                    }
                    if (Object.keys(entry).length) entries.push(entry);
                }
                msg.payload = { ok: true, domain: parseInt(domain), entries: entries };
                node.status({ fill: 'green', shape: 'dot', text: entries.length + ' entries' });
                send(msg); done();
            })
            .catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-elog', GoFaElogNode);
};

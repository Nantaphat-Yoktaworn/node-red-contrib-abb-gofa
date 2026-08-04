'use strict';
var gate = require('./lib/gate');
var createSubscription = require('./lib/rws-subscription');

function meetsSeverity(entry, minSeverity) {
    return !!entry && parseInt(entry.msgtype) >= minSeverity;
}

function parseEntry(body) {
    var liRe = /<li class="elog-message(?:-li)?"[^>]*>([\s\S]*?)<\/li>/;
    var spanRe = /class="([^"]+)">([^<]*)</g;
    var fields = ['seqnum', 'msgtype', 'code', 'title', 'tstamp'];
    var li = liRe.exec(body);
    if (!li) return null;
    var entry = {};
    var span;
    while ((span = spanRe.exec(li[1])) !== null) {
        var cls = span[1].trim();
        if (fields.indexOf(cls) >= 0) entry[cls] = span[2].trim();
    }
    return Object.keys(entry).length ? entry : null;
}

module.exports = function(RED) {
    function GoFaSubscribeElogNode(config) {
        RED.nodes.createNode(this, config);
        this.robot       = RED.nodes.getNode(config.robot);
        this.domain      = config.domain || '1';
        this.minSeverity = parseInt(config.minSeverity) || 1;
        var node = this;
        var _rawSend = node.send.bind(node);
        node.send = gate(config, _rawSend);
        node._ws      = null;
        node._pollkey = null;
        node._wsTimer = null;
        node._stopped = false;

        // The WS frame only announces THAT an event arrived, with a self link —
        // the entry itself has to be fetched.
        function fetchAndEmit(href) {
            if (!/\?/.test(href)) href += '?lang=en'; else href += '&lang=en';
            node.robot.rwsGet(href).then(function(body) {
                if (node._stopped) return;
                var entry = parseEntry(body);
                if (meetsSeverity(entry, node.minSeverity)) {
                    node.send({ payload: { ok: true, domain: parseInt(node.domain), entry: entry } });
                }
            }).catch(function(err) { node.error(err); });
        }

        // C3: subscribe/WS/reconnect mechanics live in lib/rws-subscription.js.
        var sub = createSubscription(node, {
            resourcePath: '/rw/elog/' + encodeURIComponent(node.domain),
            priority: 1,
            onStatus: function(s) { node.status(s); },
            onMessage: function(data) {
                var str = data.toString();
                var evRe = /<li class="elog-message-ev"[^>]*>([\s\S]*?)<\/li>/g;
                var hrefRe = /href="([^"]+)"\s+rel="self"/;
                var ev;
                while ((ev = evRe.exec(str)) !== null) {
                    var hm = hrefRe.exec(ev[1]);
                    if (hm) fetchAndEmit(hm[1]);
                }
            }
        });

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { node.error('No robot configured'); return done(); }
            sub.start();
            done();
        });

        node.on('close', function(done) {
            node._stopped = true;
            sub.stop(done);
        });
    }
    RED.nodes.registerType('gofa-subscribe-elog', GoFaSubscribeElogNode);
};
module.exports.parseEntry = parseEntry;
module.exports.meetsSeverity = meetsSeverity;

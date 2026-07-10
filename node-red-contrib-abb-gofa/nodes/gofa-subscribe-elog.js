'use strict';
var WS = require('ws');

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
        node._ws      = null;
        node._pollkey = null;
        node._wsTimer = null;
        node._stopped = false;

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

        function startSubscription() {
            if (!node.robot) { node.error('No robot configured'); return; }
            if (node._ws)    { return; }
            var robot        = node.robot;
            var resourcePath = '/rw/elog/' + encodeURIComponent(node.domain);
            var priority     = 1;

            node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });

            var subscribeBody = 'resources=1&1=' + encodeURIComponent(resourcePath) + '&1-p=' + priority;
            robot.requestRaw('POST', '/subscription', subscribeBody, {
                contentType: 'application/x-www-form-urlencoded;v=2.0'
            }).then(function(res) {
                if (res.statusCode !== 201) throw new Error('Subscription failed: HTTP ' + res.statusCode);
                return robot.getCookie().then(function(cookie) {
                    return { location: res.headers.location, cookie: cookie };
                });
            }).then(function(sub) {
                if (node._stopped) {
                    // Node was closed while the subscribe POST was still in flight — close() already
                    // ran and couldn't clean this up (node._pollkey was still null at that time).
                    // Best-effort delete the now-orphaned subscription ourselves.
                    var pk = sub.location.split('/poll/').pop();
                    node.robot.requestRaw('DELETE', '/subscription/' + pk, null, {}).catch(function(){});
                    return;
                }
                node._pollkey = sub.location.split('/poll/').pop();
                node._wsTimer = setTimeout(function() {
                    node._wsTimer = null;
                    if (node._stopped) return;
                    var ws = new WS(sub.location, ['rws_subscription'], {
                        rejectUnauthorized: false,
                        headers: { Cookie: sub.cookie || '' }
                    });
                    node._ws = ws;
                    ws.on('open', function() {
                        node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                    });
                    ws.on('message', function(data) {
                        var str = data.toString();
                        var evRe = /<li class="elog-message-ev"[^>]*>([\s\S]*?)<\/li>/g;
                        var hrefRe = /href="([^"]+)"\s+rel="self"/;
                        var ev;
                        while ((ev = evRe.exec(str)) !== null) {
                            var hm = hrefRe.exec(ev[1]);
                            if (hm) fetchAndEmit(hm[1]);
                        }
                    });
                    ws.on('error', function(err) {
                        node.warn('GoFa WebSocket subscription error: ' + err.message);
                    });
                    ws.on('close', function() {
                        if (node._ws) {
                            node._ws = null;
                            if (!node._stopped) {
                                node.status({ fill: 'yellow', shape: 'ring', text: 'reconnecting...' });
                                setTimeout(function() { if (!node._stopped) startSubscription(); }, 3000);
                            } else {
                                node.status({ fill: 'grey', shape: 'ring', text: 'disconnected' });
                            }
                        }
                    });
                }, 100);
            }).catch(function(err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err);
            });
        }

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured'); return done(); }
            startSubscription();
            done();
        });

        node.on('close', function(done) {
            node._stopped = true;
            if (node._wsTimer) { clearTimeout(node._wsTimer); node._wsTimer = null; }
            var ws = node._ws;
            node._ws = null;
            if (ws) { ws.terminate(); }
            if (node._pollkey && node.robot) {
                var pk = node._pollkey;
                node._pollkey = null;
                node.robot.requestRaw('DELETE', '/subscription/' + pk, null, {})
                    .catch(function(){})
                    .then(function(){ done(); });
            } else { done(); }
        });
    }
    RED.nodes.registerType('gofa-subscribe-elog', GoFaSubscribeElogNode);
};
module.exports.parseEntry = parseEntry;
module.exports.meetsSeverity = meetsSeverity;

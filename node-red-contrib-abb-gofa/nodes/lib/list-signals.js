'use strict';
// Parses the XHTML <li class="ios-signal-li"> list from GET /rw/iosystem/signals.
function parseSignalList(body) {
    var signals = [];
    var liRegex = /<li class="ios-signal-li"[^>]*>([\s\S]*?)<\/li>/g;
    var spanRegex = /<span class="([^"]+)"[^>]*>([^<]*)<\/span>/g;
    var liMatch;

    while ((liMatch = liRegex.exec(body)) !== null) {
        var inner = liMatch[1];
        var item = {};
        var spanMatch;
        spanRegex.lastIndex = 0;
        while ((spanMatch = spanRegex.exec(inner)) !== null) {
            var cls = spanMatch[1];
            var val = spanMatch[2].trim();
            if (cls === 'name' || cls === 'type' || cls === 'lvalue') {
                item[cls] = val;
            }
        }
        if (item.name) {
            signals.push(item);
        }
    }
    return signals;
}

// GET /rw/iosystem/signals returns AT MOST 100 signals per response and links the
// rest through <a href="signals?start=100&limit=100" rel="next">. The 100 is a hard
// controller-side cap, NOT a default that a bigger request overrides — confirmed live
// 2026-08-05 that ?limit=500, ?limit=1000 and ?start=0&limit=300 each still came back
// with exactly 100 items and a "next" link. Following the link is the only way to see
// the whole list.
//
// This bit nobody until a Modbus TCP add-in was installed: the controller had 96
// signals, just under the cap, so page one WAS the whole list. Modbus added 161 more
// (273 total) and, because the list is ordered with the Modbus device first, all 32
// ABB_Scalable_* signals fell onto pages 2-3 — every Known Signals dropdown in the
// palette silently lost them while appearing to work fine.
var NEXT_LINK = /<a\s[^>]*href="([^"]*)"[^>]*rel="next"/;
var MAX_PAGES = 100; // runaway guard: 100 pages x 100 signals is far past any real system

// Resolve a next-link href (observed relative, e.g. "signals?start=100&limit=100")
// against the /rw/iosystem/ collection base.
function resolveNext(href) {
    var path = href.replace(/&amp;/g, '&');
    if (path.indexOf('http') === 0) path = path.replace(/^https?:\/\/[^/]+/, '');
    return path.charAt(0) === '/' ? path : '/rw/iosystem/' + path;
}

// Fetch EVERY I/O signal, following pagination. Resolves to the same array shape
// parseSignalList returns. Any page after the first failing is swallowed and the
// signals gathered so far are returned — a partial dropdown beats an empty one.
function fetchSignals(robot) {
    var all = [];
    var seen = {};

    function page(path, n) {
        return robot.rwsGet(path).then(function(body) {
            all = all.concat(parseSignalList(body));
            var m = body.match(NEXT_LINK);
            if (!m || n + 1 >= MAX_PAGES) return all;
            var next = resolveNext(m[1]);
            if (seen[next]) return all; // controller echoing a link we already followed
            seen[next] = true;
            return page(next, n + 1);
        });
    }

    return page('/rw/iosystem/signals', 0).catch(function(err) {
        if (all.length) return all;
        throw err;
    });
}

module.exports = parseSignalList;
module.exports.fetchSignals = fetchSignals;
module.exports.parseSignalList = parseSignalList;

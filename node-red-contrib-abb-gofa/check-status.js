'use strict';
// Standalone GoFa status check — no Node-RED runtime required. Reads
// ctrl-state/opmode/RAPID execstate/speed over RWS and pings the RAPID
// socket server, then prints a compact summary. Meant to be run directly
// (`node check-status.js`) as a preflight check before live-testing anything
// against the robot — see CLAUDE.md's "check robot status before live test"
// convention.
var robot          = require('./nodes/gofa-robot');
var createRobotClient = robot.createRobotClient;
var parseXhtml        = robot.parseXhtml;
var parseLiSpans       = require('./nodes/gofa-rapid-tasks').parseLiSpans;

var args = process.argv.slice(2);
var full = args.indexOf('--full') >= 0;
var json = args.indexOf('--json') >= 0;

var cfg = {
    ip:         process.env.GOFA_IP         || '192.168.20.36',
    rwsPort:    parseInt(process.env.GOFA_RWS_PORT)    || 443,
    socketPort: parseInt(process.env.GOFA_SOCKET_PORT) || 1025,
    username:   process.env.GOFA_USERNAME   || 'NNNN',
    password:   process.env.GOFA_PASSWORD   || 'robotics'  // ABB factory default
};

var client = createRobotClient(cfg);

function settled(label, promise) {
    return promise.then(
        function(value) { return { label: label, ok: true, value: value }; },
        function(err)   { return { label: label, ok: false, error: err.message }; }
    );
}

Promise.all([
    settled('ctrlstate', client.rwsGet('/rw/panel/ctrl-state')),
    settled('opmode',    client.rwsGet('/rw/panel/opmode')),
    settled('execution', client.rwsGet('/rw/rapid/execution')),
    settled('speed',     client.rwsGet('/rw/panel/speedratio')),
    settled('socket',    (function() {
        var t0 = Date.now();
        return client.socketSend('PING').then(function(resp) {
            if (resp.indexOf('OK:') !== 0) throw new Error('unexpected reply: ' + resp);
            return Date.now() - t0;
        });
    })())
]).then(function(results) {
    var find = function(label) { return results.filter(function(r) { return r.label === label; })[0]; };
    var ctrlstate = find('ctrlstate');
    var opmode    = find('opmode');
    var execution = find('execution');
    var speed     = find('speed');
    var socket    = find('socket');

    var rwsOk = ctrlstate.ok || opmode.ok || execution.ok; // any core RWS call succeeding means RWS itself is reachable

    var out = {
        ok: rwsOk && socket.ok,
        ip: cfg.ip,
        motors: ctrlstate.ok ? parseXhtml(ctrlstate.value, 'ctrlstate') : null,
        mode:   opmode.ok    ? parseXhtml(opmode.value, 'opmode')       : null,
        rapid:  execution.ok ? parseXhtml(execution.value, 'ctrlexecstate') : null,
        speed:  speed.ok     ? parseInt(parseXhtml(speed.value, 'speedratio')) || 0 : null,
        socket: socket.ok    ? { ok: true, rtt: socket.value } : { ok: false, error: socket.error },
        errors: results.filter(function(r) { return !r.ok; }).map(function(r) { return r.label + ': ' + r.error; })
    };

    var extra = full ? fetchFull() : Promise.resolve(null);
    return extra.then(function(fullInfo) {
        if (fullInfo) out.full = fullInfo;
        print(out, rwsOk);
    });
}).catch(function(err) {
    if (json) {
        console.log(JSON.stringify({ ok: false, ip: cfg.ip, error: err.message }, null, 2));
    } else {
        console.log('GoFa @ ' + cfg.ip + ' (RWS:' + cfg.rwsPort + ' socket:' + cfg.socketPort + ')');
        console.log('Status : UNREACHABLE (' + err.message + ')');
    }
    process.exit(1);
});

function fetchFull() {
    return Promise.all([
        settled('system', client.rwsGet('/rw/system')),
        settled('identity', client.rwsGet('/ctrl/identity')),
        settled('tasks', client.rwsGet('/rw/rapid/tasks')),
        settled('elog', client.rwsGet('/rw/elog/1?lang=en&lim=3'))
    ]).then(function(results) {
        var find = function(label) { return results.filter(function(r) { return r.label === label; })[0]; };
        var system   = find('system');
        var identity = find('identity');
        var tasks    = find('tasks');
        var elog     = find('elog');

        var info = {};
        if (system.ok)   info.rwVersion = parseXhtml(system.value, 'rwversion');
        if (identity.ok) { info.ctrlName = parseXhtml(identity.value, 'ctrl-name'); info.ctrlId = parseXhtml(identity.value, 'ctrl-id'); }
        if (tasks.ok) {
            var taskList = parseLiSpans(tasks.value, 'rap-task-li', ['name', 'type', 'taskstate', 'excstate', 'active', 'motiontask']);
            var tRob1 = taskList.filter(function(t) { return t.name === 'T_ROB1'; })[0];
            if (tRob1) info.tRob1 = tRob1;
        }
        if (elog.ok) {
            var entries = [];
            var liRe = /<li class="elog-message-li"[^>]*>([\s\S]*?)<\/li>/g;
            var spanRe = /class="([^"]+)">([^<]*)</g;
            var fields = ['seqnum', 'msgtype', 'code', 'title', 'tstamp'];
            var li;
            while ((li = liRe.exec(elog.value)) !== null) {
                var entry = {};
                var span;
                while ((span = spanRe.exec(li[1])) !== null) {
                    var cls = span[1].trim();
                    if (fields.indexOf(cls) >= 0) entry[cls] = span[2].trim();
                }
                // msgtype 1 = error, 2 = warning (matches gofa-elog.js's raw field passthrough)
                if (entry.msgtype === '1' || entry.msgtype === '2') entries.push(entry);
            }
            info.recentErrors = entries.slice(0, 3);
        }
        return info;
    });
}

function print(out, rwsOk) {
    if (json) {
        console.log(JSON.stringify(out, null, 2));
    } else {
        console.log('GoFa @ ' + cfg.ip + ' (RWS:' + cfg.rwsPort + ' socket:' + cfg.socketPort + ')');
        console.log('Motors : ' + (out.motors || 'ERROR'));
        console.log('Mode   : ' + (out.mode || 'ERROR'));
        console.log('RAPID  : ' + (out.rapid || 'ERROR'));
        console.log('Speed  : ' + (out.speed !== null ? out.speed + '%' : 'ERROR'));
        console.log('Socket : ' + (out.socket.ok ? 'ok ' + out.socket.rtt + 'ms' : 'ERROR (' + out.socket.error + ')'));
        if (out.full) {
            if (out.full.rwVersion) console.log('RobotWare  : ' + out.full.rwVersion);
            if (out.full.ctrlName)  console.log('Controller : ' + out.full.ctrlName + (out.full.ctrlId ? ' (' + out.full.ctrlId + ')' : ''));
            if (out.full.tRob1)     console.log('Task T_ROB1: active=' + out.full.tRob1.active + ' motiontask=' + out.full.tRob1.motiontask + ' excstate=' + out.full.tRob1.excstate);
            if (out.full.recentErrors) {
                console.log('Recent errors/warnings: ' + (out.full.recentErrors.length || 'none'));
                out.full.recentErrors.forEach(function(e) { console.log('  - [' + e.tstamp + '] ' + e.title); });
            }
        }
        var status = out.ok ? 'OK' : (!rwsOk ? 'UNREACHABLE (RWS: ' + out.errors.join('; ') + ')' : 'DEGRADED (' + out.errors.join('; ') + ')');
        console.log('Status : ' + status);
    }
    process.exit(out.ok ? 0 : (!rwsOk ? 1 : 2));
}

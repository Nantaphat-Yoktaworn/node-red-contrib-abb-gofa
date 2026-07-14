'use strict';
module.exports = function(RED) {
    function GoFaBackupNode(config) {
        RED.nodes.createNode(this, config);
        this.robot      = RED.nodes.getNode(config.robot);
        this.backupPath = config.backupPath || '/fileservice/$syspar/tempfolder/gofa_backup';
        var node = this;

        var activeTimeout = null;
        node._stopped = false;

        node.on('close', function(done) {
            node._stopped = true;
            if (activeTimeout) {
                clearTimeout(activeTimeout);
                activeTimeout = null;
            }
            done();
        });

        node.on('input', function(msg, send, done) {
            if (!node.robot) {
                msg.payload = { ok: false, error: 'No robot configured' };
                node.status({ fill: 'red', shape: 'ring', text: 'no robot' });
                node.error('No robot configured', msg);
                send(msg);
                return done();
            }

            var backupPath = node.backupPath;
            if (msg.payload !== null && msg.payload !== undefined) {
                if (typeof msg.payload === 'object' && msg.payload.backupPath !== undefined) {
                    backupPath = msg.payload.backupPath;
                } else if (typeof msg.payload === 'string' && msg.payload.trim()) {
                    backupPath = msg.payload.trim();
                }
            }

            if (!backupPath) {
                var errStr = 'No backup path specified';
                msg.payload = { ok: false, error: errStr };
                node.status({ fill: 'red', shape: 'ring', text: 'invalid path' });
                node.error(errStr, msg);
                send(msg);
                return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: 'starting backup...' });

            var postData = 'backup=' + encodeURIComponent(backupPath);
            node.robot.requestRaw('POST', '/ctrl/backup?action=backup', postData, {
                contentType: 'application/x-www-form-urlencoded;v=2.0'
            })
            .then(function(res) {
                if (node._stopped) return done();

                // RWS backup service returns 201 Created or 202 Accepted on success
                if (res.statusCode !== 201 && res.statusCode !== 202) {
                    var errMsg = 'HTTP ' + res.statusCode + ' starting backup';
                    var reason = (/class="msg">([^<]+)</.exec(res.body.toString('utf8')) || [])[1];
                    if (reason) errMsg += ' — ' + reason;
                    throw new Error(errMsg);
                }

                var location = res.headers['location'];
                if (!location) {
                    throw new Error('No progress Location header returned by controller');
                }

                // Extract progress path (e.g. from absolute URL to relative path)
                var progressPath = location;
                var progressIdx = location.indexOf('/progress/');
                if (progressIdx >= 0) {
                    progressPath = location.substring(progressIdx);
                }

                pollProgress(progressPath, backupPath, msg, send, done);
            })
            .catch(function(err) {
                if (node._stopped) return done();
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });

        function pollProgress(progressPath, backupPath, msg, send, done) {
            if (node._stopped) return;

            node.robot.rwsGet(progressPath)
            .then(function(body) {
                if (node._stopped) return;

                var stateStr = node.robot.parseXhtml(body, 'state');
                var state = stateStr ? stateStr.trim().toUpperCase() : 'PENDING';
                var progressVal = parseInt(node.robot.parseXhtml(body, 'progress')) || 0;

                node.status({ fill: 'blue', shape: 'dot', text: 'progress: ' + progressVal + '%' });

                if (state === 'COMPLETED' || state === 'READY') {
                    msg.payload = { ok: true, state: state.toLowerCase(), progress: 100, path: backupPath };
                    node.status({ fill: 'green', shape: 'dot', text: 'backup completed' });
                    send(msg);
                    done();
                } else if (state === 'FAILED' || state === 'ERROR') {
                    var errMsg = 'Backup failed on controller';
                    var reason = node.robot.parseXhtml(body, 'msg');
                    if (reason) errMsg += ': ' + reason;
                    msg.payload = { ok: false, state: state.toLowerCase(), progress: progressVal, error: errMsg };
                    node.status({ fill: 'red', shape: 'ring', text: 'backup failed' });
                    node.error(errMsg);
                    send(msg);
                    done(new Error(errMsg));
                } else {
                    // Still running / pending: poll again in 1 second
                    activeTimeout = setTimeout(function() {
                        pollProgress(progressPath, backupPath, msg, send, done);
                    }, 1000);
                }
            })
            .catch(function(err) {
                if (node._stopped) return;
                var errMsg = 'Error polling backup progress: ' + err.message;
                msg.payload = { ok: false, error: errMsg };
                node.status({ fill: 'red', shape: 'ring', text: 'polling error' });
                node.error(errMsg);
                send(msg);
                done(err);
            });
        }
    }
    RED.nodes.registerType('gofa-backup', GoFaBackupNode);
};

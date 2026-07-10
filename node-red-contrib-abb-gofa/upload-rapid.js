'use strict';
var fs = require('fs');
var robot = require('./nodes/gofa-robot');
var createRobotClient = robot.createRobotClient;
var patchServerIp = require('./nodes/gofa-upload-mod').patchServerIp;

var ip = process.env.GOFA_IP || '192.168.20.16';
console.log('Target IP:', ip);

var client = createRobotClient({
    ip: ip,
    rwsPort: 443,
    socketPort: 1025,
    username: 'NNNN',
    password: 'robotics'
});

async function run() {
    try {
        console.log('1. Reading and patching local files...');
        var mainText = fs.readFileSync('rapid/MainModule.mod', 'utf8');
        var mainEgmText = fs.readFileSync('rapid/MainModuleEGM.mod', 'utf8');

        var patchedMain = patchServerIp(mainText, ip);
        var patchedMainEgm = patchServerIp(mainEgmText, ip);

        console.log('   Injected IP to MainModule:', patchedMain.injected);
        console.log('   Injected IP to MainModuleEGM:', patchedMainEgm.injected);

        console.log('2. Uploading MainModule.mod to controller...');
        await client.rwsPut('/fileservice/$HOME/Programs/MainModule.mod', Buffer.from(patchedMain.text, 'utf8'), 'text/plain;v=2.0');
        console.log('   MainModule.mod uploaded successfully.');

        console.log('3. Uploading MainModuleEGM.mod to controller...');
        await client.rwsPut('/fileservice/$HOME/Programs/MainModuleEGM.mod', Buffer.from(patchedMainEgm.text, 'utf8'), 'text/plain;v=2.0');
        console.log('   MainModuleEGM.mod uploaded successfully.');

        console.log('\nUpload completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('\nError during upload:', err);
        process.exit(1);
    }
}

run();

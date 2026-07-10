'use strict';
var robot = require('./nodes/gofa-robot');
var createRobotClient = robot.createRobotClient;

var ip = process.env.GOFA_IP || '192.168.20.16';
console.log('Starting live JSON socket protocol test against GoFa at ' + ip + '...');

var client = createRobotClient({
    ip: ip,
    rwsPort: 443,
    socketPort: 1025,
    username: 'NNNN',
    password: 'robotics'
});

async function run() {
    try {
        console.log('\n1. Testing: PING');
        var resp1 = await client.socketSend({ cmd: 'ping' });
        console.log('Result:', resp1);

        console.log('\n2. Testing: SPEED');
        var resp2 = await client.socketSend({ cmd: 'speed', val: 50 });
        console.log('Result (set speed to 50):', resp2);
        var resp2b = await client.socketSend({ cmd: 'speed', val: 100 });
        console.log('Result (restore speed to 100):', resp2b);

        console.log('\n3. Testing: ZONE');
        var resp3 = await client.socketSend({ cmd: 'zone', val: 'Z10' });
        console.log('Result:', resp3);

        console.log('\n4. Testing: GETVAR (nTestVar)');
        var resp4 = await client.socketSend({ cmd: 'getvar', name: 'nTestVar' });
        console.log('Result:', resp4);

        console.log('\n5. Testing: SETVAR (nTestVar = 42)');
        var resp5 = await client.socketSend({ cmd: 'setvar', name: 'nTestVar', val: 42 });
        console.log('Result:', resp5);

        console.log('\n6. Testing: GETVAR (confirm write)');
        var resp6 = await client.socketSend({ cmd: 'getvar', name: 'nTestVar' });
        console.log('Result:', resp6);

        console.log('\n7. Testing: SETVAR (restore original value 9)');
        var resp7 = await client.socketSend({ cmd: 'setvar', name: 'nTestVar', val: 9 });
        console.log('Result:', resp7);

        console.log('\n8. Testing: SETLED (Red, no blink)');
        var resp8 = await client.socketSend({ cmd: 'setled', val: [255, 0, 0, 0] });
        console.log('Result:', resp8);

        console.log('Waiting 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('\n9. Testing: RESETLED');
        var resp9 = await client.socketSend({ cmd: 'resetled' });
        console.log('Result:', resp9);

        console.log('\nLive test completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('\nTest failed:', err);
        process.exit(1);
    }
}

run();

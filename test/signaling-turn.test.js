const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');

const backendRoot = path.resolve(__dirname, '..');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for signaling message');
    await delay(10);
  }
}

async function openWebSocket(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}

test('issues TURN credentials only after successful session registration', async () => {
  const port = await reservePort();
  const child = spawn(process.execPath, ['index.js'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      TURN_HOST: 'turn.example.com',
      TURN_SECRET: '0123456789abcdef0123456789abcdef',
      TURN_TTL: '600'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const sockets = [];

  try {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    await waitFor(() => output.includes('listening'));

    const host = await openWebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(host);
    const hostMessages = [];
    host.on('message', raw => hostMessages.push(JSON.parse(raw)));

    await delay(100);
    assert.deepEqual(hostMessages, [], 'raw WebSocket connection must not receive TURN credentials');

    host.send(JSON.stringify({ type: 'host-session', sessionId: '123456789', ownerToken: 'owner-a' }));
    await waitFor(() => hostMessages.length >= 2);
    assert.equal(hostMessages[0].type, 'ice-servers');
    assert.equal(hostMessages[1].type, 'session-hosted');
    assert.ok(hostMessages[0].iceServers.some(server => server.username && server.credential));
    assert.deepEqual(hostMessages[1].iceServers, hostMessages[0].iceServers);

    const rejected = await openWebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(rejected);
    const rejectedMessages = [];
    rejected.on('message', raw => rejectedMessages.push(JSON.parse(raw)));
    rejected.send(JSON.stringify({ type: 'join-session', sessionId: '999999999' }));
    await waitFor(() => rejectedMessages.length > 0);
    assert.deepEqual(rejectedMessages.map(message => message.type), ['error']);
    assert.equal(rejectedMessages.some(message => message.type === 'ice-servers'), false);
  } finally {
    for (const socket of sockets) socket.close();
    child.kill();
    await Promise.race([once(child, 'exit'), delay(2000)]);
  }
});

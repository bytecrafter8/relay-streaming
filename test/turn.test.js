const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createIceConfig, loadTurnConfig, shouldRefreshIceConfig } = require('../turn');

test('uses public STUN without issuing credentials when TURN is not configured', () => {
  const config = loadTurnConfig({});
  const result = createIceConfig(config);

  assert.equal(config.configured, false);
  assert.deepEqual(result.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
  assert.equal(result.expiresAt, null);
});

test('creates coturn REST credentials and all transport URLs', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const config = loadTurnConfig({ TURN_HOST: 'Turn.Example.com', TURN_SECRET: secret, TURN_TTL: '600' });
  const result = createIceConfig(config, { nowSeconds: 1_700_000_000, nonce: 'socket-a' });
  const username = '1700000600:socket-a';
  const expectedCredential = crypto.createHmac('sha1', secret).update(username).digest('base64');

  assert.equal(result.expiresAt, 1_700_000_600);
  assert.equal(result.iceServers[1].username, username);
  assert.equal(result.iceServers[1].credential, expectedCredential);
  assert.deepEqual(result.iceServers[1].urls, [
    'turn:turn.example.com:3478?transport=udp',
    'turn:turn.example.com:3478?transport=tcp',
    'turns:turn.example.com:5349?transport=tcp'
  ]);
});

test('requires complete and safe TURN settings', () => {
  assert.throws(() => loadTurnConfig({ TURN_HOST: 'turn.example.com' }), /configured together/);
  assert.throws(() => loadTurnConfig({ TURN_HOST: 'https:\/\/turn.example.com', TURN_SECRET: '0123456789abcdef' }), /hostname/);
  assert.throws(() => loadTurnConfig({ TURN_HOST: 'turn.example.com', TURN_SECRET: 'short' }), /at least 16 bytes/);
  assert.throws(() => loadTurnConfig({ TURN_HOST: 'turn.example.com', TURN_SECRET: '0123456789abcdef', TURN_TTL: '30' }), /between 60 and 86400/);
});

test('accepts TTL as a backwards-compatible alias when TURN is enabled', () => {
  const config = loadTurnConfig({ TURN_HOST: 'turn.example.com', TURN_SECRET: '0123456789abcdef', TTL: '120' });

  assert.equal(config.ttlSeconds, 120);
});

test('refreshes credentials shortly before expiration', () => {
  const config = loadTurnConfig({ TURN_HOST: 'turn.example.com', TURN_SECRET: '0123456789abcdef', TURN_TTL: '600' });

  assert.equal(shouldRefreshIceConfig({ expiresAt: 1600 }, config, 1200), false);
  assert.equal(shouldRefreshIceConfig({ expiresAt: 1600 }, config, 1400), true);
});

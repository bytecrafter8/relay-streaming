const crypto = require('crypto');

const DEFAULT_TURN_TTL = 3600;
const MIN_TURN_TTL = 60;
const MAX_TURN_TTL = 24 * 60 * 60;
const FALLBACK_STUN_URL = 'stun:stun.l.google.com:19302';

function parseTtl(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TURN_TTL;
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < MIN_TURN_TTL || ttl > MAX_TURN_TTL) {
    throw new Error(`TURN_TTL must be an integer between ${MIN_TURN_TTL} and ${MAX_TURN_TTL} seconds`);
  }
  return ttl;
}

function loadTurnConfig(env = process.env) {
  const host = String(env.TURN_HOST || '').trim().toLowerCase();
  const secret = String(env.TURN_SECRET || '');
  const ttlSeconds = parseTtl(env.TURN_TTL ?? ((host || secret) ? env.TTL : undefined));

  if (!host && !secret) return { configured: false, ttlSeconds };
  if (!host || !secret) throw new Error('TURN_HOST and TURN_SECRET must be configured together');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw new Error('TURN_HOST must be a hostname without a scheme, port, path, or query string');
  }
  if (Buffer.byteLength(secret, 'utf8') < 16) throw new Error('TURN_SECRET must contain at least 16 bytes');

  return { configured: true, host, secret, ttlSeconds };
}

function createIceConfig(config, options = {}) {
  if (!config.configured) {
    return {
      iceServers: [{ urls: FALLBACK_STUN_URL }],
      iceTransportPolicy: 'all',
      expiresAt: null
    };
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = nowSeconds + config.ttlSeconds;
  const nonce = options.nonce || crypto.randomBytes(12).toString('hex');
  const username = `${expiresAt}:${nonce}`;
  const credential = crypto.createHmac('sha1', config.secret).update(username).digest('base64');

  return {
    iceServers: [
      { urls: `stun:${config.host}:3478` },
      {
        urls: [
          `turn:${config.host}:3478?transport=udp`,
          `turn:${config.host}:3478?transport=tcp`,
          `turns:${config.host}:5349?transport=tcp`
        ],
        username,
        credential
      }
    ],
    iceTransportPolicy: 'all',
    expiresAt
  };
}

function shouldRefreshIceConfig(iceConfig, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!config.configured || !iceConfig?.expiresAt) return false;
  const refreshWindow = Math.max(30, Math.min(300, Math.floor(config.ttlSeconds / 3)));
  return iceConfig.expiresAt - nowSeconds <= refreshWindow;
}

module.exports = {
  DEFAULT_TURN_TTL,
  FALLBACK_STUN_URL,
  createIceConfig,
  loadTurnConfig,
  shouldRefreshIceConfig
};

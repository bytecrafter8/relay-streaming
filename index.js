const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const sessions = new Map();
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ service: 'relay-signaling', ok: true, sessions: sessions.size }));
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const send = (ws, message) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
const validId = value => /^\d{9}$/.test(String(value || ''));

function detach(ws) {
  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (session) {
    if (ws.role === 'host' && session.host === ws) {
      session.host = null;
      for (const viewer of session.viewers.values()) send(viewer, { type: 'host-offline' });
    } else if (ws.role === 'viewer' && ws.peerId) {
      session.viewers.delete(ws.peerId);
      send(session.host, { type: 'viewer-left', peerId: ws.peerId });
    }
  }
  ws.sessionId = ws.role = ws.peerId = null;
}
function relay(ws, message) {
  const session = sessions.get(ws.sessionId); if (!session) return;
  if (ws.role === 'host') {
    if (!message.peerId) return;
    send(session.viewers.get(message.peerId), message);
  } else if (ws.role === 'viewer') {
    send(session.host, { ...message, peerId: ws.peerId });
  }
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return send(ws, { type: 'error', message: 'Invalid message' }); }
    if (m.type === 'host-session') {
      detach(ws);
      if (!validId(m.sessionId) || !m.ownerToken) return send(ws, { type: 'error', message: 'Invalid device ID or owner token' });
      let session = sessions.get(m.sessionId);
      if (session && session.ownerToken !== m.ownerToken) return send(ws, { type: 'error', message: 'Device ID belongs to another broadcaster' });
      if (!session) { session = { ownerToken: m.ownerToken, host: null, viewers: new Map() }; sessions.set(m.sessionId, session); }
      if (session.host && session.host !== ws) send(session.host, { type: 'session-replaced' });
      session.host = ws; ws.sessionId = m.sessionId; ws.role = 'host';
      send(ws, { type: 'session-hosted', sessionId: m.sessionId, viewers: [...session.viewers.keys()] });
      for (const [peerId, viewer] of session.viewers) { send(ws, { type: 'viewer-ready', peerId }); send(viewer, { type: 'host-ready', peerId }); }
      return;
    }
    if (m.type === 'join-session') {
      detach(ws);
      if (!validId(m.sessionId)) return send(ws, { type: 'error', message: 'Enter a nine-digit session ID' });
      const session = sessions.get(m.sessionId); if (!session) return send(ws, { type: 'error', message: 'Session does not exist' });
      const peerId = crypto.randomBytes(6).toString('hex');
      session.viewers.set(peerId, ws); ws.sessionId = m.sessionId; ws.role = 'viewer'; ws.peerId = peerId;
      send(ws, { type: 'session-joined', peerId, hostOnline: Boolean(session.host) });
      if (session.host) { send(session.host, { type: 'viewer-ready', peerId }); send(ws, { type: 'host-ready', peerId }); }
      return;
    }
    if (m.type === 'close-session') {
      const session = sessions.get(m.sessionId);
      if (!session || ws.role !== 'host' || session.host !== ws || session.ownerToken !== m.ownerToken) return send(ws, { type: 'error', message: 'Only the broadcaster can close this session' });
      for (const viewer of session.viewers.values()) { send(viewer, { type: 'session-closed' }); viewer.sessionId = viewer.role = viewer.peerId = null; }
      send(ws, { type: 'session-closed' }); ws.sessionId = ws.role = null; sessions.delete(m.sessionId); return;
    }
    if (['offer','answer','ice','network-mode','recovery-ack','talkback-offer','talkback-answer','talkback-ice'].includes(m.type) && ws.sessionId) relay(ws, m);
  });
  ws.on('close', () => detach(ws)); ws.on('error', () => detach(ws));
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);
function shutdown(signal) {
  console.log(`${signal} received; closing signaling service`);
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
server.listen(port, host, () => console.log(`Relay signaling listening on ${host}:${port}`));

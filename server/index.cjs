'use strict';

const http = require('node:http');
const { randomBytes, randomInt, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

function createSignalingServer({ host = '127.0.0.1', port = 21120, pendingMs = 30000, maxClients = 1000 } = {}) {
  const clients = new Set();
  const rooms = new Map();
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(req.url === '/health' ? 200 : 404);
    res.end(JSON.stringify({ ok: req.url === '/health' }));
  });
  const wss = new WebSocketServer({ server, maxPayload: 128 * 1024, perMessageDeflate: false });
  const send = (client, message) => {
    if (client?.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > 1024 * 1024) return client.terminate();
      client.send(JSON.stringify(message));
    }
  };
  function unpair(client, reason = '对方已断开') {
    const pair = client.pair;
    if (!pair) return;
    clearTimeout(pair.timer);
    pair.host.pair = pair.viewer.pair = null;
    send(pair.host, { type: 'ended', session: pair.id, reason });
    send(pair.viewer, { type: 'ended', session: pair.id, reason });
  }
  wss.on('connection', ws => {
    if (clients.size >= maxClients) return ws.close(1013, 'Server busy');
    clients.add(ws);
    ws.alive = true;
    ws.tokens = 100;
    ws.tokenTime = Date.now();
    ws.joinTime = 0;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      unpair(ws);
      if (ws.room) rooms.delete(ws.room);
      clients.delete(ws);
    });
    ws.on('message', (raw, binary) => {
      const now = Date.now();
      ws.tokens = Math.min(100, ws.tokens + (now - ws.tokenTime) / 100);
      ws.tokenTime = now;
      if (--ws.tokens < 0) return ws.close(1008, 'Rate limit');
      try {
        if (binary) throw new Error('消息格式错误');
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg.type !== 'string') throw new Error('消息格式错误');
        if (msg.type === 'register') {
          if (ws.room || ws.pair) throw new Error('当前已注册或正在连接');
          let id;
          do { id = String(randomInt(100000000, 1000000000)); } while (rooms.has(id));
          ws.room = id;
          ws.secret = randomBytes(16).toString('hex');
          rooms.set(id, ws);
          return send(ws, { type: 'registered', id, secret: ws.secret });
        }
        if (msg.type === 'join') {
          if (now - ws.joinTime < 2000) throw new Error('请稍后重试');
          ws.joinTime = now;
          if (ws.room || ws.pair) throw new Error('当前已共享或正在连接');
          const target = rooms.get(msg.id);
          const secret = typeof msg.secret === 'string' && /^[a-f0-9]{32}$/.test(msg.secret) ? msg.secret : '';
          if (!target || !secret || !timingSafeEqual(Buffer.from(secret), Buffer.from(target.secret))) {
            throw new Error('设备码或访问密钥错误，或对方未开启共享');
          }
          if (target.pair) throw new Error('对方正在连接中');
          const pair = { id: randomBytes(16).toString('hex'), host: target, viewer: ws, accepted: false };
          ws.pair = target.pair = pair;
          pair.timer = setTimeout(() => unpair(ws, '等待确认超时'), pendingMs);
          send(target, { type: 'request', session: pair.id });
          return send(ws, { type: 'waiting', session: pair.id });
        }
        const pair = ws.pair;
        if (!pair || pair.id !== msg.session) throw new Error('连接已失效');
        if (msg.type === 'approve' && pair.host === ws && !pair.accepted) {
          if (msg.allow !== true) return unpair(ws, '对方拒绝了连接');
          clearTimeout(pair.timer);
          pair.accepted = true;
          send(pair.host, { type: 'ready', session: pair.id, role: 'host' });
          return send(pair.viewer, { type: 'ready', session: pair.id, role: 'viewer' });
        }
        if (msg.type === 'leave') return unpair(ws, '连接已结束');
        if (msg.type === 'signal' && pair.accepted) {
          const data = msg.data;
          if (!data || !['offer', 'answer', 'candidate'].includes(data.type)) throw new Error('信令格式错误');
          if (data.type === 'offer' && ws !== pair.host || data.type === 'answer' && ws !== pair.viewer) throw new Error('信令方向错误');
          return send(ws === pair.host ? pair.viewer : pair.host, { type: 'signal', session: pair.id, data });
        }
        throw new Error('操作无效');
      } catch (error) {
        send(ws, { type: 'error', message: error instanceof SyntaxError ? '消息格式错误' : error.message });
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 15000);
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise(resolve => {
      clearInterval(heartbeat);
      for (const ws of clients) { unpair(ws); ws.terminate(); }
      wss.close(() => server.close(resolve));
    })
  };
}

if (require.main === module) {
  const signaling = createSignalingServer({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 21120) });
  signaling.listen().then(address => console.log(`Y-Desk signaling listening on ${address.address}:${address.port}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; signaling.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => signaling.close().then(() => process.exit(0)));
}
module.exports = { createSignalingServer };

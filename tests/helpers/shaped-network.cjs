'use strict';
const dgram = require('node:dgram');
const { isIPv4 } = require('node:net');
const { WebSocketServer, WebSocket } = require('ws');

// 仅供测试：重写 ICE 地址，让真实 WebRTC UDP 包经过延迟、限速与丢包队列。
function shapedNetwork(server, { delayMs = 60, mbps = 6, loss = 0.01 } = {}) {
  const endpoints = new Map(), timers = new Set(), connections = new Set();
  let proxy, closed = false, forwarded = 0, dropped = 0, unknown = 0, filtered = 0;
  async function endpoint(address, port, owner) {
    const key = `${address}:${port}`;
    if (endpoints.has(key)) return endpoints.get(key);
    const socket = dgram.createSocket('udp4');
    const entry = { socket, address, port, owner, ready: null, next: 0, count: 0 };
    endpoints.set(key, entry);
    entry.ready = new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '0.0.0.0', () => resolve(socket.address().port)); });
    socket.on('message', (packet, from) => {
      // 同机 ICE 可能通过另一块网卡或对等反射端口发送，学习实际源地址。
      const source = [...endpoints.values()].find(item => item.owner !== entry.owner && (item.actual?.port === from.port || item.port === from.port)) || [...endpoints.values()].find(item => item.owner !== entry.owner);
      if (!source || closed) { unknown++; return; }
      source.actual = { address: from.address, port: from.port };
      source.count++;
      if (loss && source.count % Math.round(1 / loss) === 0) { dropped++; return; }
      const now = Date.now(), sendAt = Math.max(now, source.next);
      source.next = sendAt + packet.length * 8 / (mbps * 1000);
      if (sendAt - now > 300) { dropped++; return; }
      const timer = setTimeout(() => {
        timers.delete(timer); if (!closed) { source.socket.send(packet, entry.actual?.port || entry.port, entry.actual?.address || entry.address); forwarded++; }
      }, delayMs + sendAt - now);
      timers.add(timer);
    });
    return entry;
  }
  async function rewrite(raw, owner) {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'signal' && msg.data) {
      if (msg.data.sdp) msg.data.sdp = msg.data.sdp.replace(/^a=candidate:.*\r?\n/gm, '');
      const candidate = msg.data.candidate;
      if (candidate) {
        const parts = candidate.candidate.split(' ');
        if (parts[2]?.toLowerCase() !== 'udp' || !isIPv4(parts[4]) || parts[7] !== 'host') { filtered++; return null; }
        const entry = await endpoint(parts[4], Number(parts[5]), owner); parts[5] = String(await entry.ready);
        candidate.candidate = parts.join(' ');
      }
    }
    return JSON.stringify(msg);
  }
  return {
    listen: async () => {
      const upstream = await server.listen();
      proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      proxy.on('connection', client => {
        const remote = new WebSocket(`ws://127.0.0.1:${upstream.port}`); connections.add(remote);
        let queue = new Promise((resolve, reject) => { remote.once('open', resolve); remote.once('error', reject); });
        client.on('message', raw => { queue = queue.then(async () => { const data = await rewrite(raw, client); if (data && remote.readyState === WebSocket.OPEN) remote.send(data); }).catch(() => client.close()); });
        remote.on('message', raw => { if (client.readyState === WebSocket.OPEN) client.send(raw.toString()); });
        remote.on('error', () => client.close()); remote.on('close', () => client.close());
        client.on('close', () => { remote.close(); connections.delete(remote); });
      });
      await new Promise(resolve => proxy.once('listening', resolve)); return { port: proxy.address().port };
    },
    close: async () => {
      closed = true; for (const timer of timers) clearTimeout(timer);
      for (const { socket } of endpoints.values()) socket.close();
      for (const remote of connections) remote.terminate();
      if (proxy) { for (const client of proxy.clients) client.terminate(); await new Promise(resolve => proxy.close(resolve)); }
      await server.close(); console.log(`UDP test path: ${forwarded} forwarded, ${dropped} dropped, ${endpoints.size} endpoints, ${filtered} filtered, ${unknown} unknown sources; delay ${delayMs}ms each way, ${mbps}Mbps per direction, loss ${loss}`);
    }
  };
}
module.exports = { shapedNetwork };

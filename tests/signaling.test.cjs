const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createSignalingServer } = require('../server/index.cjs');

async function fixture(t, options) {
  const server = createSignalingServer({ port: 0, ...options });
  const { port } = await server.listen();
  t.after(() => server.close());
  return async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue = [], waiters = [];
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (waiters.length) waiters.shift()(message); else queue.push(message);
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return {
      ws,
      send: data => ws.send(JSON.stringify(data)),
      next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('消息等待超时')), 3000);
        waiters.push(message => { clearTimeout(timer); resolve(message); });
      })
    };
  };
}
async function register(host) { host.send({ type: 'register' }); return host.next(); }
async function pair(host, viewer, credentials) {
  viewer.send({ type: 'join', ...credentials, type: 'join' });
  const request = await host.next();
  assert.equal(request.type, 'request');
  assert.equal((await viewer.next()).type, 'waiting');
  return request.session;
}
test('必须持有正确密钥且经被控端允许，才能交换信令', async t => {
  const connect = await fixture(t);
  const host = await connect(), bad = await connect(), viewer = await connect();
  const credentials = await register(host);
  assert.match(credentials.id, /^\d{9}$/); assert.match(credentials.secret, /^[a-f0-9]{32}$/);
  bad.send({ type: 'join', id: credentials.id, secret: '0'.repeat(32) });
  assert.equal((await bad.next()).type, 'error');
  const session = await pair(host, viewer, credentials);
  viewer.send({ type: 'signal', session, data: { type: 'offer', sdp: 'premature' } });
  assert.equal((await viewer.next()).type, 'error');
  viewer.send({ type: 'approve', session, allow: true });
  assert.equal((await viewer.next()).type, 'error');
  host.send({ type: 'approve', session, allow: true });
  assert.equal((await host.next()).role, 'host'); assert.equal((await viewer.next()).role, 'viewer');
  host.send({ type: 'signal', session, data: { type: 'offer', sdp: 'test' } });
  assert.equal((await viewer.next()).data.sdp, 'test');
  viewer.send({ type: 'signal', session, data: { type: 'answer', sdp: 'answer' } });
  assert.equal((await host.next()).data.sdp, 'answer');
  host.send({ type: 'leave', session });
  assert.equal((await host.next()).type, 'ended'); assert.equal((await viewer.next()).type, 'ended');
  viewer.send({ type: 'signal', session, data: { type: 'candidate' } });
  assert.equal((await viewer.next()).type, 'error');
});
test('请求超时释放占用，断开主机使旧设备码失效', async t => {
  const connect = await fixture(t, { pendingMs: 60 });
  const host = await connect(), viewer = await connect();
  const credentials = await register(host);
  await pair(host, viewer, credentials);
  assert.match((await viewer.next()).reason, /超时/); assert.equal((await host.next()).type, 'ended');
  await new Promise(resolve => { host.ws.once('close', resolve); host.ws.close(); });
  const another = await connect();
  another.send({ ...credentials, type: 'join' });
  assert.equal((await another.next()).type, 'error');
});
test('拒绝连接及连接中断通知双方，外部客户端无法冒充当前会话', async t => {
  const connect = await fixture(t);
  const host = await connect(), viewer = await connect(), stranger = await connect();
  const credentials = await register(host);
  const session = await pair(host, viewer, credentials);
  stranger.send({ type: 'approve', session, allow: true });
  assert.equal((await stranger.next()).type, 'error');
  host.send({ type: 'approve', session, allow: false });
  assert.match((await viewer.next()).reason, /拒绝/); assert.equal((await host.next()).type, 'ended');
  const nextViewer = await connect();
  await pair(host, nextViewer, credentials);
  nextViewer.ws.close();
  assert.equal((await host.next()).type, 'ended');
});
test('畸形消息不会使服务器崩溃', async t => {
  const connect = await fixture(t);
  const client = await connect();
  client.ws.send('{broken'); assert.equal((await client.next()).type, 'error');
  client.ws.send('null'); assert.equal((await client.next()).type, 'error');
  const registered = await register(client); assert.equal(registered.type, 'registered');
});

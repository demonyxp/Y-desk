'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { WebSocket } = require('ws');
const { newIdentity } = require('../src/auth.cjs');
const { deviceRegistry } = require('../server/registry.cjs');
const { createSignalingServer } = require('./helpers/signaling-server.cjs');

test('Node 注册表可迁移至 Go，Go 新身份可由 Node 读取，重启不能冒领设备码', { skip: !process.env.YDESK_GO_SERVER }, async t => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'ydesk-migration-')), 'devices.json');
  const original = newIdentity(), added = newIdentity();
  deviceRegistry(statePath).claim(original.id, original.ownerToken);
  let server = createSignalingServer({ port: 0, statePath });
  let address = await server.listen();
  t.after(() => server.close());
  const register = async identity => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('注册超时')), 3000);
        ws.once('message', raw => { clearTimeout(timer); resolve(JSON.parse(raw)); });
        ws.send(JSON.stringify({ type: 'register', version: 2, ...identity, authKey: randomBytes(32).toString('hex') }));
      });
    } finally { ws.terminate(); }
  };
  assert.equal((await register(original)).type, 'registered');
  assert.equal((await register(added)).type, 'registered');
  const nodeRegistry = deviceRegistry(statePath);
  nodeRegistry.claim(original.id, original.ownerToken);
  nodeRegistry.claim(added.id, added.ownerToken);
  assert.equal(Object.keys(JSON.parse(readFileSync(statePath, 'utf8'))).length, 2);
  await server.close();
  server = createSignalingServer({ port: 0, statePath });
  address = await server.listen();
  assert.match((await register({ ...original, ownerToken: randomBytes(32).toString('hex') })).message, /另一台设备/);
  assert.equal((await register(original)).type, 'registered');
});

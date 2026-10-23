'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSessionTools, safeName } = require('../src/session-tools.cjs');
async function setup(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ydesk-files-'));
  let profile = {}, sid = 'session-1', clip = '', pick, save;
  const tools = createSessionTools({ dialog: {
    showOpenDialog: async () => pick || { canceled: true }, showSaveDialog: async () => save || { canceled: true }
  }, clipboard: { readText: () => clip, writeText: value => { clip = value; } }, window: () => null,
  session: () => sid, profile: () => profile, save: value => { profile = value; }, downloads: () => dir });
  t.after(async () => { await tools.clear(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, tools, setProfile: value => { profile = value; }, setSession: value => { sid = value; }, setClipboard: value => { clip = value; }, getClipboard: () => clip,
    pick: value => { pick = value; }, save: value => { save = value; } };
}
test('文件名拒绝路径穿越、Windows 设备名和超长文件名', () => {
  for (const value of ['../secret', '..\\secret', 'C:\\a', 'a:b', 'a.', 'nul.txt', 'COM1', 'a'.repeat(181), '\0']) assert.throws(() => safeName(value));
  assert.equal(safeName('中文报告.txt'), '中文报告.txt');
});
test('剪贴板仅在授权会话且本机开启时读写，并限制 UTF-8 字节数', async t => {
  const s = await setup(t); s.setClipboard('私人文本');
  assert.equal(await s.tools.call('clipboard-read'), null);
  await s.tools.call('preferences-save', { clipboard: true });
  assert.equal(await s.tools.call('clipboard-read'), '私人文本');
  assert.equal(await s.tools.call('clipboard-write', { text: '中'.repeat(30000) }), false);
  s.setSession(null); await assert.rejects(s.tools.call('clipboard-read'), /授权/);
});
test('文件逐块接收、同名改名、拒绝覆盖和越界分块', async t => {
  const s = await setup(t); s.setProfile({ tools: { folder: s.dir, autoReceive: true } });
  await fs.writeFile(join(s.dir, '报告.txt'), '旧内容');
  const id = randomUUID();
  assert.equal(await s.tools.call('file-accept', { id, name: '报告.txt', size: 3 }), true);
  await assert.rejects(s.tools.call('file-finish', { id }), /完整/);
  await assert.rejects(s.tools.call('file-write', { id, bytes: new Uint8Array(4) }), /分块/);
  await s.tools.call('file-write', { id, bytes: new Uint8Array([1, 2, 3]) });
  await s.tools.call('file-finish', { id });
  assert.equal(await fs.readFile(join(s.dir, '报告.txt'), 'utf8'), '旧内容');
  assert.deepEqual([...await fs.readFile(join(s.dir, '报告 (1).txt'))], [1, 2, 3]);
  assert.equal((await fs.readdir(s.dir)).some(file => file.endsWith('.part')), false);
});
test('断开清理临时文件，旧任务与未选择文件的读取失效', async t => {
  const s = await setup(t); s.setProfile({ tools: { folder: s.dir, autoReceive: true } });
  const id = randomUUID(); await s.tools.call('file-accept', { id, name: 'a.bin', size: 10 });
  await s.tools.clear();
  assert.deepEqual(await fs.readdir(s.dir), []);
  await assert.rejects(s.tools.call('file-write', { id, bytes: new Uint8Array([1]) }));
  await assert.rejects(s.tools.call('file-read', { id }));
});
test('发送必须选取本地文件，分块读取不加载整个文件', async t => {
  const s = await setup(t), path = join(s.dir, 'send.bin'); await fs.writeFile(path, Buffer.alloc(40000, 7));
  s.pick({ canceled: false, filePaths: [path] });
  const file = await s.tools.call('file-pick');
  assert.equal(file.size, 40000);
  const sizes = [];
  for (let i = 0; i < 3; i++) sizes.push((await s.tools.call('file-read', { id: file.id })).length);
  assert.deepEqual(sizes, [16384, 16384, 7232]);
  await s.tools.call('file-cancel', { id: file.id });
  await assert.rejects(s.tools.call('file-read', { id: file.id }));
});
test('保存路径被其他程序占用时不覆盖，并清理临时文件', async t => {
  const s = await setup(t); s.setProfile({ tools: { folder: s.dir, autoReceive: true } });
  const id = randomUUID(); await s.tools.call('file-accept', { id, name: 'race.bin', size: 0 });
  await fs.writeFile(join(s.dir, 'race.bin'), 'keep');
  await assert.rejects(s.tools.call('file-finish', { id }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(join(s.dir, 'race.bin'), 'utf8'), 'keep');
  assert.equal((await fs.readdir(s.dir)).some(file => file.endsWith('.part')), false);
});
test('最近设备去重并限制二十条，保留备注收藏且不保存密码', async t => {
  const s = await setup(t); s.tools.record('123456789', 'wss://example.com');
  await s.tools.call('device-edit', { id: '123456789', url: 'wss://example.com', name: '家里', favorite: true });
  for (let i = 0; i < 25; i++) s.tools.record(String(200000000 + i), 'wss://example.com');
  const devices = await s.tools.call('devices'); assert.equal(devices.length, 20); assert.equal(devices[0].name, '家里');
  assert.equal(JSON.stringify(devices).includes('password'), false);
});

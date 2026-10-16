const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const file = join(__dirname, '../native/bin/YDesk.Input.exe');
const skip = process.platform !== 'win32' || !existsSync(file);

function native(t) {
  const child = spawn(file, ['--dry-run'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = []; let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    pending += data;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) if (line.trim().startsWith('{')) events.push(JSON.parse(line));
  });
  const ready = new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  const closed = new Promise(resolve => child.once('exit', resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { events, ready, closed, send: message => child.stdin.write(JSON.stringify(message) + '\n'), end: () => child.stdin.end() };
}
test('原生组件按 UTF-8 解码中文并生成正确的 Unicode 按下/抬起事件', { skip }, async t => {
  const helper = native(t); await helper.ready;
  helper.send({ type: 'text', text: '中文' }); helper.end(); await helper.closed;
  const keys = helper.events.filter(event => event.native);
  assert.deepEqual(keys.map(key => [key.scan, key.flags]), [[20013, 4], [20013, 6], [25991, 4], [25991, 6]]);
});
test('原生组件在输入管道关闭时释放按键和鼠标', { skip }, async t => {
  const helper = native(t); await helper.ready;
  helper.send({ type: 'key', vk: 163, extended: true, down: true });
  helper.send({ type: 'button', x: 20, y: 20, button: 0, down: true });
  helper.end(); await helper.closed;
  const events = helper.events.filter(event => event.native);
  assert.deepEqual(events.filter(event => event.type === 'key').map(event => event.flags), [1, 3]);
  assert.ok(events.some(event => event.type === 'mouse' && event.flags === 2));
  assert.ok(events.some(event => event.type === 'mouse' && event.flags === 4));
});
test('原生看门狗在无心跳时自动抬键', { skip, timeout: 8000 }, async t => {
  const helper = native(t); await helper.ready;
  helper.send({ type: 'key', vk: 65, extended: false, down: true });
  await new Promise(resolve => setTimeout(resolve, 4300));
  assert.ok(helper.events.some(event => event.native && event.type === 'key' && event.vk === 65 && event.flags === 2));
  helper.end(); await helper.closed;
});

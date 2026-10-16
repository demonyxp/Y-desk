const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { passwordKey, validatePassword, newIdentity } = require('../src/auth.cjs');
const { deviceRegistry } = require('../server/registry.cjs');
test('自设密码支持中文、大小写和空格，派生结果绑定设备码', async () => {
  const password = '  测试Password2026  ';
  const first = await passwordKey(password, '123456789');
  assert.equal(first, await passwordKey(password, '123456789'));
  for (const changed of [password.trim(), password.toLowerCase()]) assert.notEqual(first, await passwordKey(changed, '123456789'));
  assert.notEqual(first, await passwordKey(password, '123456788'));
  assert.throws(() => validatePassword('1234567'));
  assert.throws(() => validatePassword(' '.repeat(8)));
});
test('设备所有权落盘后重启仍有效，不保存原始所有权令牌', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ydesk-registry-')), 'devices.json');
  const identity = newIdentity();
  deviceRegistry(file).claim(identity.id, identity.ownerToken);
  assert.ok(!readFileSync(file, 'utf8').includes(identity.ownerToken));
  const restarted = deviceRegistry(file);
  assert.doesNotThrow(() => restarted.claim(identity.id, identity.ownerToken));
  assert.throws(() => restarted.claim(identity.id, '0'.repeat(64)), /另一台设备/);
});

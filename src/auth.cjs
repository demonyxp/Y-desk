'use strict';
const { scrypt, randomBytes, randomInt } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || !password.trim()) {
    throw new Error('密码请设置为 8–128 个字符，区分大小写');
  }
  return password;
}
async function passwordKey(password, deviceId) {
  validatePassword(password);
  if (!/^\d{9}$/.test(deviceId)) throw new Error('请输入 9 位设备码');
  return (await derive(password, `Y-Desk/v2/${deviceId}`, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
}
function newIdentity() { return { id: String(randomInt(100000000, 1000000000)), ownerToken: randomBytes(32).toString('hex') }; }
module.exports = { passwordKey, validatePassword, newIdentity };

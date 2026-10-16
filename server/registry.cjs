'use strict';
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const digest = value => createHash('sha256').update(value).digest('hex');
function deviceRegistry(file) {
  const devices = new Map(file && existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : []);
  function claim(id, ownerToken) {
    if (!/^\d{9}$/.test(id) || typeof ownerToken !== 'string' || !/^[a-f0-9]{64}$/.test(ownerToken)) throw new Error('设备身份无效，请更新客户端');
    const owner = digest(ownerToken);
    if (devices.has(id)) {
      if (devices.get(id) !== owner) throw new Error('设备码属于另一台设备，不能覆盖');
      return;
    }
    if (devices.size >= 10000) throw new Error('设备注册数量已达上限');
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries([...devices, [id, owner]])), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    }
    devices.set(id, owner);
  }
  return { claim };
}
module.exports = { deviceRegistry, digest };

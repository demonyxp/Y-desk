'use strict';
const { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } = require('node:fs');
const { dirname } = require('node:path');
const { newIdentity } = require('./auth.cjs');
function settingsStore(file, encryption) {
  if (!encryption.isEncryptionAvailable()) throw new Error('Windows 加密存储不可用，无法保存无人值守配置');
  const load = () => {
    if (!existsSync(file)) return { identity: newIdentity(), unattended: false, autoStart: false, autoShare: false };
    const value = JSON.parse(encryption.decryptString(readFileSync(file)));
    if (!/^\d{9}$/.test(value.identity?.id) || !/^[a-f0-9]{64}$/.test(value.identity?.ownerToken)) throw new Error('设备配置无效');
    return value;
  };
  const save = value => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, encryption.encryptString(JSON.stringify(value)), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  return { load, save };
}
module.exports = { settingsStore };

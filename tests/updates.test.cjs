'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates } = require('../src/updates.cjs');

function setup(options = {}) {
  const updater = new EventEmitter();
  const calls = [];
  updater.checkForUpdates = async () => { calls.push('check'); updater.emit('update-available', { version: '0.4.0' }); };
  updater.downloadUpdate = async () => { calls.push('download'); updater.emit('download-progress', { percent: 67.3 }); updater.emit('update-downloaded', { version: '0.4.0' }); };
  updater.quitAndInstall = (...args) => calls.push(['install', ...args]);
  const states = [];
  const updates = createUpdates({ updater, enabled: true, installable: true, version: '0.3.0', emit: state => states.push(state),
    isBusy: () => false, beforeInstall: () => calls.push('prepare'), installFailed: () => calls.push('recover'), ...options });
  return { updater, updates, calls, states };
}
test('检查不自动下载；下载有进度，显式安装才会退出，禁止降级和退出时安装', async () => {
  const { updater, updates, calls, states } = setup();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.disableWebInstaller, true);
  await updates.check();
  assert.deepEqual(calls, ['check']);
  await updates.download();
  assert.equal(updates.getState().status, 'downloaded');
  assert.ok(states.some(state => state.status === 'downloading' && state.progress === 67));
  await updates.check();
  assert.deepEqual(calls, ['check', 'download']);
  updates.install(); updates.install();
  assert.deepEqual(calls, ['check', 'download', 'prepare', ['install', false, true]]);
});
test('下载后建立了远程连接也会阻止安装；断开后可重试', async () => {
  let busy = true;
  const { updates, calls } = setup({ isBusy: () => busy });
  await updates.check(); await updates.download();
  assert.equal(updates.install().status, 'downloaded');
  assert.match(updates.getState().message, /先断开/);
  assert.deepEqual(calls, ['check', 'download']);
  busy = false;
  assert.equal(updates.install().status, 'installing');
});
test('并发检查、重复下载合并；失败后允许重试', async () => {
  const { updater, updates, calls } = setup();
  let finish;
  updater.checkForUpdates = () => new Promise(resolve => { calls.push('check'); finish = resolve; });
  const pending = updates.check();
  await updates.check();
  assert.deepEqual(calls, ['check']);
  updater.emit('update-available', { version: '0.4.0' }); finish(); await pending;
  updater.downloadUpdate = () => new Promise(resolve => { calls.push('download'); finish = resolve; });
  const downloading = updates.download();
  await updates.download();
  assert.deepEqual(calls, ['check', 'download']);
  updater.emit('error', new Error('checksum mismatch')); finish(); await downloading;
  assert.equal(updates.getState().status, 'error');
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  assert.equal((await updates.check()).status, 'current');
});
test('安装失败恢复共享；检查网络异常不产生未处理的拒绝', async () => {
  const { updater, updates, calls } = setup();
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  assert.equal((await updates.check()).status, 'error');
  updater.emit('update-downloaded', { version: '0.4.0' });
  updater.quitAndInstall = () => updater.emit('error', new Error('install failed'));
  assert.equal(updates.install().status, 'error');
  assert.deepEqual(calls, ['prepare', 'recover']);
});
test('便携版只检查版本，不下载安装；开发模式不访问更新服务', async () => {
  const portable = setup({ installable: false });
  assert.equal((await portable.updates.check()).status, 'available');
  await portable.updates.download(); portable.updates.install();
  assert.deepEqual(portable.calls, ['check']);
  const dev = setup({ enabled: false });
  await dev.updates.check(); await dev.updates.download(); dev.updates.install();
  assert.equal(dev.updates.getState().status, 'unsupported');
  assert.deepEqual(dev.calls, []);
});

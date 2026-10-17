'use strict';
// 先运行 npm run dist；真实下载和校验安装包，只替换最后的安装调用，避免改动测试机安装状态。
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createReadStream, mkdtempSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const WebSocket = require('ws');
const { createSignalingServer } = require('../server/index.cjs');
const { passwordKey } = require('../src/auth.cjs');

(async () => {
  const version = require('../package.json').version;
  const nextVersion = version.replace(/\d+$/, patch => Number(patch) + 1);
  const installer = resolve(`dist/Y-Desk-Setup-${version}-win-x64.exe`);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  const checksum = hash.digest('base64');
  let corrupt = true;
  const server = createServer((req, res) => {
    if (req.url.split('?')[0] === '/latest.yml') {
      res.end(`version: ${nextVersion}\nfiles:\n  - url: update.exe\n    sha512: ${checksum}\n    size: ${statSync(installer).size}\npath: update.exe\nsha512: ${checksum}\n`);
    } else if (req.url === '/update.exe') {
      if (corrupt) res.end('invalid installer');
      else { res.writeHead(200, { 'content-length': statSync(installer).size }); createReadStream(installer).pipe(res); }
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const signaling = createSignalingServer({ port: 0 });
  const signalAddress = await signaling.listen();
  const profile = mkdtempSync(join(tmpdir(), 'ydesk-update-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app, viewer;
  try {
    app = await electron.launch({ executablePath: resolve('dist/win-unpacked/Y-Desk.exe'), args: [`--user-data-dir=${profile}`], env });
    const config = await app.evaluate(({ app, BrowserWindow }, { url, cache }) => {
      const updater = process.mainModule.require('electron-updater').autoUpdater;
      updater.setFeedURL({ provider: 'generic', url });
      updater.disableDifferentialDownload = true;
      Object.defineProperty(updater.app, 'baseCachePath', { get: () => cache });
      globalThis.updateInstallCalls = [];
      updater.quitAndInstall = (...args) => globalThis.updateInstallCalls.push(args);
      BrowserWindow.getAllWindows()[0].hide();
      return { autoDownload: updater.autoDownload, autoInstallOnAppQuit: updater.autoInstallOnAppQuit };
    }, { url: `http://127.0.0.1:${server.address().port}`, cache: join(profile, 'update-cache') });
    assert.deepEqual(config, { autoDownload: false, autoInstallOnAppQuit: false });
    const page = await app.firstWindow();
    await page.locator('.screen-card').first().waitFor();
    await page.locator('#check-update').click();
    await expect(page.locator('#update-message')).toContainText(`v${nextVersion}`);
    // 截图时显示但不抢焦点，避免 Windows 隐藏窗口停止合成导致超时。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await page.screenshot({ path: resolve('test-results/update-available.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await page.locator('#download-update').click();
    await expect(page.locator('#update-message')).toContainText('更新失败', { timeout: 30000 });
    await expect(page.locator('#install-update')).toBeHidden();
    corrupt = false;
    await page.locator('#check-update').click();
    await expect(page.locator('#download-update')).toBeVisible();
    await page.locator('#download-update').click();
    await expect(page.locator('#install-update')).toBeVisible({ timeout: 60000 });
    const state = await page.evaluate(() => window.ydesk.updateState());
    assert.equal(state.progress, 100);
    assert.equal(state.status, 'downloaded');
    const password = 'UpdateTest#2026';
    await page.locator('#server').fill(`ws://127.0.0.1:${signalAddress.port}`);
    await page.locator('#host-password').fill(password);
    await page.locator('#share').click();
    await expect(page.locator('#status')).toHaveText('共享就绪 · 等待连接');
    const id = (await page.locator('#device-id').textContent()).replace(/\s/g, '');
    const authKey = await passwordKey(password, id);
    viewer = new WebSocket(`ws://127.0.0.1:${signalAddress.port}`);
    await new Promise((resolve, reject) => { viewer.once('open', resolve); viewer.once('error', reject); });
    viewer.send(JSON.stringify({ type: 'join', id, authKey }));
    await expect(page.locator('#request')).toBeVisible();
    await page.locator('#install-update').click();
    await expect(page.locator('#update-message')).toContainText('请先断开');
    assert.deepEqual(await app.evaluate(() => globalThis.updateInstallCalls), []);
    await page.locator('#stop').click();
    await expect(page.locator('#status')).toHaveText('未连接');
    await page.locator('#install-update').click();
    assert.deepEqual(await app.evaluate(() => globalThis.updateInstallCalls), [[false, true]]);
    console.log('Packaged update: discovery, corrupt-file rejection, real download + SHA512, pending-session guard, explicit installer invocation passed. OS install was mocked.');
  } finally {
    viewer?.terminate();
    if (app) await app.close().catch(() => {});
    await signaling.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

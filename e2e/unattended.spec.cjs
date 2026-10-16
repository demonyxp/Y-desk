const { test, expect, _electron: electron } = require('@playwright/test');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createSignalingServer } = require('../server/index.cjs');

test('无人值守：密码、托盘、加密保存、重启、断网重连和主动停止', async () => {
  test.setTimeout(120000);
  const root = mkdtempSync(join(tmpdir(), 'ydesk-unattended-'));
  const statePath = join(root, 'devices.json');
  let server = createSignalingServer({ port: 0, statePath });
  const { port } = await server.listen();
  const apps = [];
  const launch = async name => {
    const env = { ...process.env, YDESK_TEST_MODE: '1', YDESK_PROFILE: join(root, name) };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args: ['.'], env }); apps.push(app);
    const page = await app.firstWindow();
    await expect(page.locator('.screen-card').first()).toBeVisible();
    return { app, page };
  };
  try {
    let host = await launch('host');
    const password = '我的Desk密码#2026';
    await host.page.locator('#server').fill(`ws://127.0.0.1:${port}`);
    await host.page.locator('#host-password').fill(password);
    await host.page.locator('#unattended').check();
    await host.page.locator('#share').click();
    await expect(host.page.locator('#status')).toHaveText('共享就绪 · 等待连接');
    await expect(host.page.locator('#device-id')).toHaveText(/\d{3} \d{3} \d{3}/);
    const deviceId = (await host.page.locator('#device-id').textContent()).replace(/\s/g, '');
    expect(readFileSync(join(root, 'host/settings.bin')).includes(Buffer.from(password))).toBe(false);
    await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    await host.app.close();
    host = await launch('host');
    await expect(host.page.locator('#status')).toHaveText(/等待连接/, { timeout: 15000 });
    expect((await host.page.locator('#device-id').textContent()).replace(/\s/g, '')).toBe(deviceId);
    expect(await host.page.locator('#host-password').inputValue()).toBe('');
    const viewer = await launch('viewer');
    await viewer.page.locator('#server').fill(`ws://127.0.0.1:${port}`);
    await viewer.page.locator('#remote-id').fill(deviceId);
    await viewer.page.locator('#remote-password').fill('wrong-password');
    await viewer.page.locator('#join').click();
    await expect(viewer.page.locator('#notice')).toContainText('密码错误');
    await expect(host.page.locator('#request')).toBeHidden();
    await viewer.page.locator('#remote-password').fill(password);
    // 服务端对同一连接的尝试节流；错误后客户端已重建连接。
    await viewer.page.locator('#join').click();
    await expect(viewer.page.locator('#status')).toHaveText(/已连接/, { timeout: 30000 });
    await expect(host.page.locator('#request')).toBeHidden();
    await expect.poll(() => viewer.page.locator('video').evaluateAll(items => items.length > 0 && items.every(video => video.videoWidth > 0))).toBe(true);
    await server.close();
    await expect(host.page.locator('#status')).toHaveText(/等待恢复/, { timeout: 10000 });
    server = createSignalingServer({ port, statePath }); await server.listen();
    await expect(host.page.locator('#status')).toHaveText(/等待连接/, { timeout: 15000 });
    expect((await host.page.locator('#device-id').textContent()).replace(/\s/g, '')).toBe(deviceId);
    await host.app.evaluate(({ powerMonitor }) => { powerMonitor.emit('lock-screen'); powerMonitor.emit('suspend'); powerMonitor.emit('resume'); });
    await expect(host.page.locator('#status')).toHaveText(/等待恢复/);
    await host.page.waitForTimeout(1500);
    await expect(host.page.locator('#status')).toHaveText(/等待恢复/);
    await host.app.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
    await expect(host.page.locator('#status')).toHaveText(/等待连接/, { timeout: 10000 });
    await host.page.locator('#stop').click();
    await expect(host.page.locator('#status')).toHaveText('未连接');
    await expect(host.page.locator('#device-id')).toBeVisible();
    expect((await host.page.locator('#device-id').textContent()).replace(/\s/g, '')).toBe(deviceId);
    await expect(host.page.locator('#copy-invite')).toBeDisabled();
    await host.app.close();
    host = await launch('host');
    await expect(host.page.locator('#status')).toHaveText('未连接');
    expect((await host.page.locator('#device-id').textContent()).replace(/\s/g, '')).toBe(deviceId);
    expect(await host.page.evaluate(async () => (await window.ydesk.settings()).autoShare)).toBe(false);
  } finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    await server.close();
  }
});

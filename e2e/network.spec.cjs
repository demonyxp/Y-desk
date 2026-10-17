const { test, expect, _electron: electron } = require('@playwright/test');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createSignalingServer } = require('../tests/helpers/signaling-server.cjs');

test('中继表单自动生成配置、加密保存、重启回填并保留高级配置', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'ydesk-network-'));
  const server = createSignalingServer({ port: 0 });
  const { port } = await server.listen();
  const env = { ...process.env, YDESK_TEST_MODE: '1', YDESK_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const launch = async () => {
    app = await electron.launch({ args: ['.'], env });
    const page = await app.firstWindow();
    await expect(page.locator('.screen-card').first()).toBeVisible();
    return page;
  };
  try {
    let page = await launch();
    await expect(page.locator('#ice')).toBeHidden();
    await page.locator('#server').fill(`ws://127.0.0.1:${port}`);
    await page.locator('#relay-user').fill('ydesk');
    await page.locator('#relay-password').fill('RelaySecret2026');
    await page.locator('#host-password').fill('HostSecret2026');
    await page.locator('#share').click();
    await expect(page.locator('#status')).toHaveText(/等待连接/);
    const settings = await page.evaluate(() => window.ydesk.settings());
    expect(settings.ice[1].urls).toEqual(['turn:127.0.0.1:3478?transport=udp', 'turn:127.0.0.1:3478?transport=tcp']);
    expect(readFileSync(join(profile, 'settings.bin')).includes(Buffer.from('RelaySecret2026'))).toBe(false);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('RelaySecret2026');
    await page.locator('#stop').click();
    await app.close();
    page = await launch();
    await expect(page.locator('#relay-user')).toHaveValue('ydesk');
    await expect(page.locator('#relay-password')).toHaveValue('RelaySecret2026');
    await expect(page.locator('#advanced-network')).not.toBeChecked();
    await page.locator('#advanced-network').check();
    const advanced = [{ urls: ['turns:relay.example.com:5349?transport=tcp'], username: 'custom', credential: 'AdvancedSecret2026' }];
    await page.locator('#ice').fill(JSON.stringify(advanced));
    await page.locator('#host-password').fill('HostSecret2026');
    await page.locator('#share').click();
    await expect(page.locator('#status')).toHaveText(/等待连接/);
    await page.locator('#stop').click();
    await app.close();
    page = await launch();
    await expect(page.locator('#advanced-network')).toBeChecked();
    expect(JSON.parse(await page.locator('#ice').inputValue())).toEqual(advanced);
  } finally {
    if (app) await app.close().catch(() => {});
    await server.close();
  }
});

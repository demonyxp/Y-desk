const { test, expect, _electron: electron } = require('@playwright/test');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createSignalingServer } = require('../server/index.cjs');

test('设备码在离线启动、连接失败和重启后始终可见并可复制', async ({}, testInfo) => {
  const env = { ...process.env, YDESK_TEST_MODE: '1', YDESK_PROFILE: mkdtempSync(join(tmpdir(), 'ydesk-identity-')) };
  delete env.ELECTRON_RUN_AS_NODE;
  // 关闭临时服务器，复现新用户未部署信令服务时的连接失败。
  const server = createSignalingServer({ port: 0 });
  const { port } = await server.listen();
  await server.close();
  let app;
  try {
    app = await electron.launch({ args: ['.'], env });
    let page = await app.firstWindow();
    await page.locator('#network-settings').evaluate(element => { element.open = true; });
    await expect(page.locator('#device-id')).toHaveText(/^\d{3} \d{3} \d{3}$/);
    await expect(page.locator('#device-id')).toBeInViewport();
    await expect(page.locator('#copy-invite')).toBeDisabled();
    const formattedId = await page.locator('#device-id').textContent();
    await app.evaluate(({ clipboard }) => { clipboard.writeText = value => { globalThis.testCopiedId = value; }; });
    await page.locator('#copy-device-id').click();
    expect(await app.evaluate(() => globalThis.testCopiedId)).toBe(formattedId.replace(/\s/g, ''));
    await page.screenshot({ path: testInfo.outputPath('device-id-offline.png') });
    await page.locator('.screen-card').first().waitFor();
    await page.locator('#server').fill(`ws://127.0.0.1:${port}`);
    await page.locator('#host-password').fill('Offline-Test#2026');
    await page.locator('#share').click();
    await expect(page.locator('#notice')).toHaveClass(/error/);
    await expect(page.locator('#status')).toHaveText('未连接');
    await expect(page.locator('#device-id')).toHaveText(formattedId);
    await expect(page.locator('#device-id')).toBeVisible();
    await expect(page.locator('#copy-device-id')).toBeEnabled();
    await expect(page.locator('#copy-invite')).toBeDisabled();
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await expect(page.locator('#device-id')).toHaveText(formattedId);
    await expect(page.locator('#device-id')).toBeInViewport();
  } finally { if (app) await app.close().catch(() => {}); }
});

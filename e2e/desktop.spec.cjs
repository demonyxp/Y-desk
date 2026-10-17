const { test, expect, _electron: electron } = require('@playwright/test');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createSignalingServer } = require('../tests/helpers/signaling-server.cjs');

for (const syntheticDual of [false, true]) test(syntheticDual ? '双屏模拟：两路视频、屏幕切换、画质和断开清理' : 'Windows 实际屏幕采集、WebRTC 传输、控制事件、断开清理', async ({}, testInfo) => {
  const server = createSignalingServer({ port: 0 });
  const { port } = await server.listen();
  const apps = [];
  try {
    const launch = async name => {
      const env = { ...process.env, YDESK_TEST_MODE: '1', YDESK_PROFILE: mkdtempSync(join(tmpdir(), `ydesk-${name}-`)) };
      delete env.ELECTRON_RUN_AS_NODE;
      const app = await electron.launch({ args: ['.'], env }); apps.push(app);
      const page = await app.firstWindow();
      await page.locator('#server').fill(`ws://127.0.0.1:${port}`);
      await expect(page.locator('.screen-card').first()).toBeVisible();
      return { app, page };
    };
    const host = await launch('host'), viewer = await launch('viewer');
    if (syntheticDual) {
      // 单显示器测试机使用两路独立测试图，验证双轨协商和路由；不冒充双物理屏实测。
      await host.app.evaluate(async ({ desktopCapturer, screen }) => {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        const first = screen.getAllDisplays().find(display => String(display.id) === sources[0].display_id);
        const second = { ...first, id: first.id + 12345, bounds: { ...first.bounds, x: first.bounds.x + first.bounds.width } };
        screen.getAllDisplays = () => [first, second];
        desktopCapturer.getSources = async () => [sources[0], { ...sources[0], id: 'screen:synthetic:0', display_id: String(second.id), name: '模拟屏幕 2' }];
      });
      await host.page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = async constraints => {
          const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
          const ctx = canvas.getContext('2d'); let frame = 0;
          setInterval(() => {
            ctx.fillStyle = constraints.video.mandatory.chromeMediaSourceId === 'screen:synthetic:0' ? '#154a80' : '#146048';
            ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = '#fff'; ctx.font = '40px sans-serif'; ctx.fillText(String(frame++), 80, 80);
          }, 33);
          return canvas.captureStream(30);
        };
      });
      await host.page.locator('#refresh').click();
      await expect(host.page.locator('.screen-card')).toHaveCount(2);
    }
    const screenCount = Math.min(2, await host.page.locator('.screen-card').count());
    await host.page.screenshot({ path: testInfo.outputPath('home.png') });
    const password = 'Desk-Test#2026';
    await host.page.locator('#host-password').fill(password);
    await host.page.locator('#share').click();
    await expect(host.page.locator('#status')).toHaveText('共享就绪 · 等待连接');
    await expect(host.page.locator('#device-id')).toHaveText(/\d{3} \d{3} \d{3}/);
    const id = (await host.page.locator('#device-id').textContent()).replace(/\s/g, '');
    await host.app.evaluate(({ clipboard }) => { clipboard.writeText = value => { globalThis.testCopiedInvite = value; }; });
    await host.page.locator('#copy-invite').click();
    expect(await host.app.evaluate(() => globalThis.testCopiedInvite)).toContain(id);
    expect(await host.app.evaluate(() => globalThis.testCopiedInvite)).not.toContain(password);
    await viewer.page.locator('#remote-id').fill(id);
    await viewer.page.locator('#remote-password').fill(password);
    await viewer.page.locator('#join').click();
    await expect(host.page.locator('#request')).toBeVisible();
    await expect(viewer.page.locator('video')).toHaveCount(0);
    await host.page.evaluate(() => { window.testInputs = []; window.ydesk.onEvent(event => { if (event.type === 'test-input') window.testInputs.push(event.data); }); });
    await host.page.locator('#accept').click();
    await expect(viewer.page.locator('video')).toHaveCount(screenCount, { timeout: 30000 });
    await expect(viewer.page.locator('#status')).toHaveText(/已连接/, { timeout: 30000 });
    await expect.poll(() => viewer.page.locator('video').evaluateAll(videos => videos.every(video => video.videoWidth > 0 && video.readyState >= 2)), { timeout: 20000 }).toBe(true);
    await expect(viewer.page.locator('#stats')).toHaveText(/Mbps/, { timeout: 10000 });
    const video = viewer.page.locator('video').first();
    await video.click();
    await viewer.page.keyboard.press('a');
    await expect.poll(() => host.page.evaluate(() => window.testInputs.join(''))).toContain('"vk":65');
    await host.page.evaluate(() => { window.testInputs = []; });
    await viewer.page.keyboard.down('Control');
    await video.click();
    await viewer.page.keyboard.press('c');
    await viewer.page.keyboard.up('Control');
    await expect.poll(() => host.page.evaluate(() => window.testInputs.join(''))).toContain('"vk":67');
    const commands = await host.page.evaluate(() => window.testInputs.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => !event.native));
    const modifierDown = commands.findIndex(event => event.type === 'key' && event.vk === 162 && event.down);
    const letter = commands.findIndex(event => event.type === 'key' && event.vk === 67 && event.down);
    expect(modifierDown).toBeGreaterThanOrEqual(0);
    expect(letter).toBeGreaterThan(modifierDown);
    expect(commands.slice(modifierDown, letter).some(event => event.type === 'release')).toBe(false);
    await viewer.page.locator('.text-transfer summary').click();
    await viewer.page.locator('#remote-text').fill('中文测试');
    await viewer.page.locator('#send-text').click();
    await expect.poll(() => host.page.evaluate(() => window.testInputs.join(''))).toContain('中文测试');
    await viewer.page.locator('#quality').selectOption('smooth');
    await expect.poll(() => host.page.evaluate(() => pc.getSenders().filter(sender => sender.track?.kind === 'video').reduce((sum, sender) => sum + sender.getParameters().encodings[0].maxBitrate, 0))).toBe(4000000);
    await expect.poll(() => viewer.page.evaluate(() => motionChannel?.readyState)).toBe('open');
    expect(await viewer.page.evaluate(() => ({ ordered: motionChannel.ordered, maxRetransmits: motionChannel.maxRetransmits }))).toEqual({ ordered: false, maxRetransmits: 0 });
    await host.page.evaluate(() => { window.testInputs = []; });
    await viewer.page.evaluate(() => sendData({ type: 'move', screen: remoteScreens[0].id, x: 0.25, y: 0.25 }));
    await expect.poll(() => host.page.evaluate(() => window.testInputs.join(''))).toContain('"type":"move"');
    await viewer.page.evaluate(() => { release(); });
    await expect.poll(() => host.page.evaluate(() => window.testInputs.join(''))).toContain('"type":"release"');
    await expect(video).toHaveCSS('cursor', 'default');
    await viewer.page.locator('#fullscreen').click();
    await expect(viewer.page.locator('body')).toHaveClass(/session-fullscreen/);
    await expect.poll(() => viewer.page.locator('#videos').evaluate(element => element.getBoundingClientRect().height / innerHeight)).toBeGreaterThan(0.7);
    await expect(viewer.page.locator('#disconnect-session')).toBeVisible();
    await viewer.page.locator('#fullscreen').click();
    await expect(viewer.page.locator('body')).not.toHaveClass(/session-fullscreen/);
    if (screenCount === 2) {
      await viewer.page.locator('#layout').selectOption({ index: 1 });
      await expect(viewer.page.locator('.remote-screen:visible')).toHaveCount(1);
      await expect.poll(() => host.page.evaluate(() => pc.getSenders().filter(sender => sender.track?.kind === 'video' && sender.getParameters().encodings[0].active).length)).toBe(1);
      await viewer.page.locator('#layout').selectOption('all');
      await expect(viewer.page.locator('.remote-screen:visible')).toHaveCount(2);
      const nextWindow = viewer.app.waitForEvent('window');
      await viewer.page.locator('#separate-screen').click();
      const second = await nextWindow;
      const placement = await viewer.app.evaluate(({ BrowserWindow, screen }) => {
        const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
        const child = BrowserWindow.getAllWindows().find(w => w !== main);
        return { count: screen.getAllDisplays().length, main: screen.getDisplayMatching(main.getBounds()).id, child: screen.getDisplayMatching(child.getBounds()).id };
      });
      if (placement.count > 1) expect(placement.child).not.toBe(placement.main);
      await expect(second.locator('video')).toHaveCount(1);
      await expect.poll(() => second.locator('video').evaluate(element => element.videoWidth)).toBeGreaterThan(0);
      await expect(viewer.page.locator('video')).toHaveCount(1);
      await expect.poll(() => host.page.evaluate(() => pc.getSenders().filter(sender => sender.track?.kind === 'video' && sender.getParameters().encodings[0].active).length)).toBe(2);
      await second.locator('video').click();
      await second.keyboard.press('b');
      await expect.poll(() => host.page.evaluate(() => window.testInputs.join(''))).toContain('"vk":66');
      await second.locator('#screen-fullscreen').click();
      await expect(second.locator('#screen-fullscreen')).toHaveText('退出全屏');
      await expect.poll(() => second.locator('video').evaluate(element => element.getBoundingClientRect().height / innerHeight)).toBeGreaterThan(0.85);
      await second.locator('#screen-fullscreen').click();
      await second.screenshot({ path: testInfo.outputPath('second-screen.png') });
      await second.locator('#screen-return').click();
      await expect(viewer.page.locator('video')).toHaveCount(2);
      await expect(viewer.page.locator('.remote-screen:visible')).toHaveCount(2);
      await viewer.page.locator('#separate-screen').click();
      await expect.poll(() => viewer.app.windows().length).toBe(2);
    }
    console.log(`${syntheticDual ? 'Synthetic' : 'Actual'} captured displays: ${screenCount}; ${await viewer.page.locator('#stats').textContent()}`);
    console.log('Encoder diagnostics:', await host.page.evaluate(async () => [...(await pc.getStats()).values()].filter(report => report.type === 'outbound-rtp' && report.kind === 'video').map(report => ({ width: report.frameWidth, height: report.frameHeight, fps: report.framesPerSecond, limitation: report.qualityLimitationReason }))));
    await viewer.page.locator('#stop').click();
    await expect(host.page.locator('#status')).toHaveText(/等待连接/);
    await expect.poll(() => host.page.evaluate(() => captureStreams.length)).toBe(0);
    await expect(viewer.page.locator('video')).toHaveCount(0);
    await expect.poll(() => viewer.app.windows().length).toBe(1);
    await host.page.locator('#stop').click();
    await expect(host.page.locator('#status')).toHaveText('未连接');
  } finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    await server.close();
  }
});

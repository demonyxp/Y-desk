'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, Menu, powerSaveBlocker, powerMonitor, clipboard } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const WebSocket = require('ws');
const { serverUrl, iceServers, normalizeInput, QUALITY } = require('./shared.cjs');

const testMode = !app.isPackaged && process.env.YDESK_TEST_MODE === '1';
if (testMode && process.env.YDESK_PROFILE) app.setPath('userData', process.env.YDESK_PROFILE);
let window, socket, helper, sessionId, pendingId, approvedId, blocker;
let allowedDisplays = [], availableDisplays = [], hosting = false, controlAllowed = false;
let connectionGeneration = 0;
let invitation = null;
const pageUrl = pathToFileURL(join(__dirname, 'renderer/index.html')).href;
const emit = message => { if (window && !window.isDestroyed()) window.webContents.send('event', message); };

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) throw new Error('信令服务器未连接');
  socket.send(JSON.stringify(message));
}
function stopInput() {
  controlAllowed = false;
  if (helper) {
    const child = helper;
    helper = null;
    child.stdin.end(JSON.stringify({ type: 'release' }) + '\n');
    const timeout = setTimeout(() => child.kill(), 1500);
    child.once('exit', () => clearTimeout(timeout));
  }
}
function stopSession() {
  stopInput();
  sessionId = pendingId = approvedId = null;
  if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
  blocker = undefined;
}
function disconnect() {
  connectionGeneration++;
  stopSession();
  hosting = false;
  invitation = null;
  allowedDisplays = [];
  if (socket) { const current = socket; socket = null; current.close(); }
}
async function startInput() {
  const file = app.isPackaged ? join(process.resourcesPath, 'native/YDesk.Input.exe') : join(__dirname, '../native/bin/YDesk.Input.exe');
  if (!existsSync(file)) throw new Error('缺少输入组件，请先运行 npm run build:native');
  const child = spawn(file, testMode ? ['--dry-run'] : [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  helper = child;
  child.stdin.on('error', () => {});
  let lastError = 0;
  child.stderr.on('data', () => {
    if (Date.now() - lastError > 5000) { lastError = Date.now(); emit({ type: 'input-error', message: '系统阻止输入：无法控制 UAC 安全桌面或更高权限窗口。' }); }
  });
  child.on('exit', () => {
    if (helper === child) { helper = null; controlAllowed = false; emit({ type: 'input-error', message: '输入组件已停止，请断开后重新连接。' }); }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('输入组件启动超时')), 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.once('data', data => {
      clearTimeout(timeout);
      if (!data.toString().startsWith('ready')) reject(new Error('输入组件启动失败')); else resolve();
    });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('输入组件意外退出')); });
  });
  // 消耗输出，避免子进程管道填满。
  child.stdout.on('data', data => { if (testMode) emit({ type: 'test-input', data: data.toString() }); });
}
function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) {
    throw new Error('拒绝不可信调用');
  }
}
function handle(name, fn) { ipcMain.handle(name, async (event, ...args) => { trusted(event); return fn(...args); }); }

handle('screens', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
  const displays = screen.getAllDisplays();
  availableDisplays = sources.map(source => {
    const display = displays.find(item => String(item.id) === source.display_id);
    return display && {
      id: source.id, displayId: display.id, name: display.label || source.name,
      bounds: display.bounds, scaleFactor: display.scaleFactor,
      width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor),
      thumbnail: source.thumbnail.toDataURL()
    };
  }).filter(Boolean);
  return availableDisplays;
});
handle('connect', async options => {
  const url = serverUrl(options.url);
  const ice = iceServers(options.ice);
  if (!['host', 'viewer'].includes(options.role)) throw new Error('连接方式错误');
  if (options.role === 'host') {
    if (!Array.isArray(options.screens) || !options.screens.length || options.screens.length > 2 || new Set(options.screens).size !== options.screens.length) throw new Error('请选择 1 至 2 个屏幕');
    if (options.screens.some(id => !availableDisplays.some(display => display.id === id))) throw new Error('显示器已变化，请刷新屏幕列表');
  } else if (!/^\d{9}$/.test(options.id) || !/^[a-f0-9]{32}$/.test(options.secret)) throw new Error('请输入 9 位设备码和 32 位访问密钥');
  disconnect();
  const generation = connectionGeneration;
  hosting = options.role === 'host';
  allowedDisplays = hosting ? availableDisplays.filter(display => options.screens.includes(display.id)) : [];
  const ws = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 128 * 1024, perMessageDeflate: false });
  socket = ws;
  ws.on('message', raw => {
    if (socket !== ws) return;
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'registered' && hosting) invitation = `Y-Desk\n服务器：${url}\n设备码：${message.id}\n访问密钥：${message.secret}`;
      if (message.type === 'request' && hosting) pendingId = message.session;
      if (message.type === 'waiting' && !hosting) pendingId = message.session;
      if (message.type === 'ready') {
        if (message.session !== pendingId || hosting && approvedId !== message.session) return;
        sessionId = message.session;
        controlAllowed = hosting && Boolean(helper);
        blocker = powerSaveBlocker.start('prevent-display-sleep');
        message.screens = allowedDisplays.map(({ thumbnail, ...display }) => display);
        message.ice = ice;
      }
      if (message.type === 'signal' && message.session !== sessionId) return;
      if (message.type === 'ended') {
        if (message.session !== sessionId && message.session !== pendingId) return;
        stopSession();
      }
      emit(message);
    } catch { emit({ type: 'error', message: '收到无效服务器消息' }); }
  });
  ws.on('close', () => {
    if (socket === ws) { disconnect(); emit({ type: 'offline', message: '信令连接已断开，请重新连接' }); }
  });
  ws.on('error', () => { if (socket === ws) emit({ type: 'error', message: '无法连接服务器，请检查地址、网络和 TLS 证书' }); });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('连接已关闭')));
  });
  if (generation !== connectionGeneration) throw new Error('连接已取消');
  send(hosting ? { type: 'register' } : { type: 'join', id: options.id, secret: options.secret });
  return true;
});
handle('approve', async ({ session, allow }) => {
  if (!hosting || pendingId !== session || approvedId) throw new Error('请求已过期');
  if (allow) {
    approvedId = session;
    try { await startInput(); } catch (error) { stopInput(); approvedId = null; throw error; }
    if (pendingId !== session) { stopInput(); throw new Error('请求已取消'); }
  }
  send({ type: 'approve', session, allow: allow === true });
});
handle('signal', data => {
  if (!sessionId || !data || !['offer', 'answer', 'candidate'].includes(data.type) || JSON.stringify(data).length > 120000) return;
  send({ type: 'signal', session: sessionId, data });
});
handle('capture', id => {
  if (!hosting || !sessionId || approvedId !== sessionId || !allowedDisplays.some(display => display.id === id)) throw new Error('屏幕共享未获授权');
  return id;
});
handle('leave', () => {
  if (sessionId || pendingId) { try { send({ type: 'leave', session: sessionId || pendingId }); } catch {} }
  stopSession();
});
handle('disconnect', () => disconnect());
handle('fullscreen', enabled => window.setFullScreen(Boolean(enabled)));
handle('copy-invite', () => {
  if (!hosting || !invitation) throw new Error('请先开启共享');
  clipboard.writeText(invitation);
});
handle('qualities', () => QUALITY);
ipcMain.on('input', (event, message) => {
  trusted(event);
  if (!sessionId || !hosting || !controlAllowed || !helper) return;
  const normalized = normalizeInput(message, allowedDisplays, point => screen.dipToScreenPoint(point));
  if (normalized && !helper.stdin.destroyed && helper.stdin.writableLength < 65536) helper.stdin.write(JSON.stringify(normalized) + '\n');
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1220, height: 850, minWidth: 920, minHeight: 680, title: 'Y-Desk', backgroundColor: '#eef3f8',
    icon: join(__dirname, '../assets/icon.ico'),
    show: !testMode,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === window.webContents && permission === 'media' && hosting && Boolean(sessionId));
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission) => contents === window.webContents && permission === 'media' && hosting && Boolean(sessionId));
  window.webContents.on('render-process-gone', () => disconnect());
  window.loadFile(join(__dirname, 'renderer/index.html'));
  // 本地紧急停止不依赖远端网络和渲染进程。
  const registered = globalShortcut.register('Control+Alt+F12', () => { disconnect(); window.destroy(); });
  if (!registered) window.webContents.once('did-finish-load', () => emit({ type: 'notice', message: '紧急快捷键 Ctrl+Alt+F12 被占用，请使用窗口中的停止共享按钮。' }));
  window.on('unresponsive', () => { disconnect(); window.destroy(); });
  for (const event of ['lock-screen', 'suspend']) powerMonitor.on(event, () => {
    if (hosting) { disconnect(); window.webContents.reload(); }
  });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => {
    if (hosting) { disconnect(); emit({ type: 'offline', message: '显示器布局发生变化，已停止共享。请刷新屏幕后重新连接。' }); }
  });
});
app.on('before-quit', () => { disconnect(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());

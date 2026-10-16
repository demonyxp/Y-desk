'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, Menu, powerSaveBlocker, powerMonitor, clipboard, safeStorage, Tray, dialog, shell } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const WebSocket = require('ws');
const { serverUrl, iceServers, normalizeInput, QUALITY } = require('./shared.cjs');
const { passwordKey, validatePassword } = require('./auth.cjs');
const { settingsStore } = require('./settings.cjs');
const { createUpdates } = require('./updates.cjs');

const testMode = !app.isPackaged && process.env.YDESK_TEST_MODE === '1';
if (testMode && process.env.YDESK_PROFILE) app.setPath('userData', process.env.YDESK_PROFILE);
let window, socket, helper, sessionId, pendingId, approvedId, blocker;
let allowedDisplays = [], availableDisplays = [], hosting = false, controlAllowed = false;
let connectionGeneration = 0;
let invitation = null;
let updates, updateTimer, updateInterval;
let store, profile, tray, desired = null, reconnectTimer, reconnectAttempts = 0, locked = false, suspended = false, quitting = false;
const canAutoStart = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE;
if (!testMode && !app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
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
function updateTray() {
  if (!tray) return;
  tray.setToolTip(desired?.unattended ? 'Y-Desk · 无人值守已开启' : 'Y-Desk');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Y-Desk', click: () => { window.show(); window.focus(); } },
    { label: '停止共享', enabled: Boolean(hosting || desired), click: () => { stopSharing(); emit({ type: 'offline', message: '共享已停止，下次启动不会自动共享' }); window.show(); } },
    { type: 'separator' }, { label: '退出程序', click: () => app.quit() }
  ]));
}
function stopSharing() {
  desired = null;
  clearTimeout(reconnectTimer);
  if (profile?.autoShare) { profile.autoShare = false; store.save(profile); }
  disconnect(); updateTray();
}
function scheduleReconnect(reason) {
  if (!desired?.unattended || locked || suspended || quitting) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempts++, 5));
  emit({ type: 'reconnecting', message: `${reason}，${delay / 1000} 秒后重试` });
  reconnectTimer = setTimeout(async () => {
    if (!desired || locked || suspended || quitting) return;
    try {
      await listScreens();
      if (!desired || locked || suspended || quitting) return;
      const selected = desired.displayIds.map(id => availableDisplays.find(display => display.displayId === id));
      if (selected.some(display => !display)) throw new Error('等待原先选择的显示器恢复');
      await connectTo({ ...desired, screens: selected.map(display => display.id) }, true);
    } catch (error) { scheduleReconnect(error.message); }
  }, delay);
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

async function listScreens() {
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
}
handle('screens', listScreens);
handle('settings', () => ({
  id: profile.identity.id, url: profile.url, ice: profile.ice || [], displayIds: profile.displayIds || [],
  unattended: Boolean(profile.unattended), autoStart: Boolean(profile.autoStart),
  autoShare: Boolean(profile.autoShare && profile.unattended && profile.password),
  passwordSaved: Boolean(profile.password), canAutoStart
}));
handle('resume', () => {
  if (!profile.autoShare || !profile.unattended || !profile.password) return false;
  desired = { role: 'host', url: profile.url, ice: profile.ice, password: profile.password,
    unattended: true, autoStart: canAutoStart && profile.autoStart, displayIds: profile.displayIds };
  updateTray(); scheduleReconnect('正在恢复无人值守'); return true;
});
async function connectTo(options, retry = false) {
  if (quitting) throw new Error('程序正在退出，请稍后重试');
  const url = serverUrl(options.url);
  const ice = iceServers(options.ice);
  if (!['host', 'viewer'].includes(options.role)) throw new Error('连接方式错误');
  if (locked || suspended) throw new Error('Windows 已锁屏或休眠，恢复桌面后会继续无人值守');
  const password = validatePassword(options.password || (options.role === 'host' ? profile.password : ''));
  if (options.role === 'host') {
    if (!Array.isArray(options.screens) || !options.screens.length || options.screens.length > 2 || new Set(options.screens).size !== options.screens.length) throw new Error('请选择 1 至 2 个屏幕');
    if (options.screens.some(id => !availableDisplays.some(display => display.id === id))) throw new Error('显示器已变化，请刷新屏幕列表');
    if (options.autoStart && (!canAutoStart || !options.unattended)) throw new Error('登录自启需要安装版并开启无人值守');
  } else if (!/^\d{9}$/.test(options.id)) throw new Error('请输入 9 位设备码');
  clearTimeout(reconnectTimer);
  disconnect();
  const generation = connectionGeneration;
  const authKey = await passwordKey(password, options.role === 'host' ? profile.identity.id : options.id);
  if (generation !== connectionGeneration || quitting) throw new Error('连接已取消');
  hosting = options.role === 'host';
  allowedDisplays = hosting ? availableDisplays.filter(display => options.screens.includes(display.id)) : [];
  if (!retry) {
    desired = hosting && options.unattended ? { ...options, url, ice, password, displayIds: allowedDisplays.map(display => display.displayId) } : null;
    if (hosting) {
      const next = { ...profile, url, ice: options.unattended ? ice : [], displayIds: allowedDisplays.map(display => display.displayId),
        unattended: Boolean(options.unattended), autoStart: Boolean(options.autoStart), autoShare: Boolean(options.unattended) };
      if (options.unattended) next.password = password; else delete next.password;
      store.save(next); profile = next;
      if (canAutoStart && !testMode) app.setLoginItemSettings({ openAtLogin: profile.autoStart, path: process.execPath, args: ['--autostart'], name: 'Y-Desk' });
    }
    updateTray();
  }
  const ws = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 128 * 1024, perMessageDeflate: false });
  let registrationTimer;
  socket = ws;
  ws.on('message', raw => {
    if (socket !== ws) return;
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'registered' && hosting) {
        clearTimeout(registrationTimer);
        if (message.version !== 2 || message.id !== profile.identity.id) {
          emit({ type: 'error', fatal: true, message: '信令服务器版本过旧，请同时升级服务器到 v0.2.0 或更新版本' }); return;
        }
        invitation = `Y-Desk\n服务器：${url}\n设备码：${message.id}\n请向设备所有者获取连接密码`;
        reconnectAttempts = 0; message.unattended = Boolean(desired?.unattended);
      }
      if (message.type === 'request' && hosting) {
        pendingId = message.session;
        message.unattended = Boolean(desired?.unattended);
        if (message.unattended) void approveSession({ session: message.session, allow: true }).catch(error => {
          if (socket === ws) { emit({ type: 'notice', message: error.message }); try { send({ type: 'approve', session: message.session, allow: false }); } catch {} }
        });
      }
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
    clearTimeout(registrationTimer);
    if (socket === ws) {
      disconnect();
      if (desired?.unattended) scheduleReconnect('信令连接已断开');
      else emit({ type: 'offline', message: '信令连接已断开，请重新连接' });
    }
  });
  ws.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', () => reject(new Error('无法连接服务器，请检查地址、网络和 TLS 证书')));
      ws.once('close', () => reject(new Error('连接已关闭')));
    });
  } catch (error) { if (desired?.unattended) return { retrying: true }; throw error; }
  if (generation !== connectionGeneration) throw new Error('连接已取消');
  send(hosting ? { type: 'register', version: 2, ...profile.identity, authKey } : { type: 'join', id: options.id, authKey });
  if (hosting) registrationTimer = setTimeout(() => { if (socket === ws) ws.terminate(); }, 10000);
  return true;
}
handle('connect', options => connectTo(options));
async function approveSession({ session, allow }) {
  if (!hosting || pendingId !== session || approvedId) throw new Error('请求已过期');
  const generation = connectionGeneration;
  if (allow) {
    approvedId = session;
    try { await startInput(); } catch (error) {
      if (pendingId === session && generation === connectionGeneration) { stopInput(); approvedId = null; }
      throw error;
    }
    if (pendingId !== session || generation !== connectionGeneration) throw new Error('请求已取消');
  }
  send({ type: 'approve', session, allow: allow === true });
}
handle('approve', approveSession);
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
handle('disconnect', stopSharing);
handle('fullscreen', enabled => window.setFullScreen(Boolean(enabled)));
handle('copy-device-id', () => clipboard.writeText(profile.identity.id));
handle('copy-invite', () => {
  if (!hosting || !invitation) throw new Error('请先开启共享');
  clipboard.writeText(invitation);
});
handle('qualities', () => QUALITY);
handle('updates-state', () => updates.getState());
handle('updates-check', () => updates.check());
handle('updates-download', () => updates.download());
handle('updates-install', () => updates.install());
handle('updates-page', () => shell.openExternal('https://github.com/demonyxp/Y-desk/releases/latest'));
ipcMain.on('input', (event, message) => {
  trusted(event);
  if (!sessionId || !hosting || !controlAllowed || !helper) return;
  const normalized = normalizeInput(message, allowedDisplays, point => screen.dipToScreenPoint(point));
  if (normalized && !helper.stdin.destroyed && helper.stdin.writableLength < 65536) helper.stdin.write(JSON.stringify(normalized) + '\n');
});

app.whenReady().then(() => {
  store = settingsStore(join(app.getPath('userData'), 'settings.bin'), safeStorage);
  profile = store.load();
  // 第一次运行就固定设备身份；密码只在用户开启无人值守后保存。
  store.save(profile);
  updates = createUpdates({
    updater: app.isPackaged ? require('electron-updater').autoUpdater : null,
    enabled: app.isPackaged && process.platform === 'win32', installable: canAutoStart,
    version: app.getVersion(), emit: state => emit({ type: 'update-state', state }),
    isBusy: () => Boolean(sessionId || pendingId || approvedId || socket && !hosting),
    beforeInstall: () => { quitting = true; clearTimeout(reconnectTimer); disconnect(); },
    installFailed: () => { quitting = false; scheduleReconnect('更新未完成，恢复共享'); }
  });
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1220, height: 850, minWidth: 920, minHeight: 680, title: 'Y-Desk', backgroundColor: '#eef3f8',
    icon: join(__dirname, '../assets/icon.ico'),
    show: !testMode && !process.argv.includes('--autostart'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === window.webContents && permission === 'media' && hosting && Boolean(sessionId));
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission) => contents === window.webContents && permission === 'media' && hosting && Boolean(sessionId));
  window.webContents.on('render-process-gone', () => disconnect());
  tray = new Tray(join(__dirname, '../assets/icon.ico'));
  tray.on('double-click', () => { window.show(); window.focus(); });
  updateTray();
  window.on('close', event => {
    if (!quitting && desired?.unattended) { event.preventDefault(); window.hide(); }
  });
  window.loadFile(join(__dirname, 'renderer/index.html'));
  if (app.isPackaged) {
    updateTimer = setTimeout(() => void updates.check(), 15000);
    updateInterval = setInterval(() => void updates.check(), 6 * 60 * 60 * 1000);
    updateTimer.unref(); updateInterval.unref();
  }
  // 本地紧急停止不依赖远端网络和渲染进程。
  const registered = globalShortcut.register('Control+Alt+F12', () => { stopSharing(); app.quit(); });
  if (!registered) window.webContents.once('did-finish-load', () => emit({ type: 'notice', message: '紧急快捷键 Ctrl+Alt+F12 被占用，请使用窗口中的停止共享按钮。' }));
  window.on('unresponsive', () => { disconnect(); window.destroy(); });
  for (const event of ['lock-screen', 'suspend']) powerMonitor.on(event, () => {
    if (event === 'lock-screen') locked = true; else suspended = true;
    clearTimeout(reconnectTimer);
    if (hosting || desired) { disconnect(); emit({ type: desired ? 'reconnecting' : 'offline', message: 'Windows 已锁屏或休眠，解锁后恢复无人值守' }); }
  });
  for (const event of ['unlock-screen', 'resume']) powerMonitor.on(event, () => {
    if (event === 'unlock-screen') locked = false; else suspended = false;
    scheduleReconnect('桌面已恢复');
  });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => {
    if (hosting || desired) {
      disconnect();
      if (desired) scheduleReconnect('显示器布局变化，正在重新读取');
      else emit({ type: 'offline', message: '显示器布局发生变化，已停止共享。请刷新屏幕后重新连接。' });
    }
  });
}).catch(error => { dialog.showErrorBox('Y-Desk 启动失败', error.message); app.quit(); });
app.on('before-quit', () => { quitting = true; clearTimeout(reconnectTimer); clearTimeout(updateTimer); clearInterval(updateInterval); disconnect(); tray?.destroy(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());

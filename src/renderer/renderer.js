'use strict';

const $ = id => document.getElementById(id);
const api = window.ydesk;
let pc, channel, role, sessionId, pendingId, captureStreams = [], localScreens = [], remoteScreens = [];
let epoch = 0, busy = false, sharing = false, allowControl = true, fullScreen = false;
let qualities, candidates = [], statsTimer, heartbeatTimer, connectionTimer, disconnectedTimer;
let quality = 'auto', lastStats = new Map(), eventQueue = Promise.resolve(), controlCount = 0, controlWindow = 0;
let unattended = false, canAutoStart = false, preferredDisplays = [];
let motionChannel, inputSequence = 0, lastMotionSequence = 0, hostScreenIds = [], visibleScreenIds = null;
let qualityQueue = Promise.resolve(), secondWindow = null, detachedSurface = null, secondFullscreen = false;
let adaptiveState = null, hostDisplays = [], restartAttempts = 0, restartTimer, restarting = false;
let adaptiveTick = 0;
const toolsUI = new SessionTools({ api, sendControl: sendData, session: () => sessionId, notice, action });
function renderUpdate(state) {
  $('update-version').textContent = `软件更新 · 当前 v${state.currentVersion}`;
  $('update-message').textContent = state.message;
  $('check-update').disabled = ['checking', 'downloading', 'installing'].includes(state.status);
  $('download-update').hidden = state.status !== 'available' || !state.installable;
  $('install-update').hidden = state.status !== 'downloaded';
  $('update-page').hidden = !['error', 'unsupported'].includes(state.status) && (state.installable || state.status !== 'available');
  $('update-progress').hidden = state.status !== 'downloading';
  $('update-progress').value = state.progress;
  if (['available', 'downloading', 'downloaded', 'installing', 'error'].includes(state.status)) $('update-panel').hidden = false;
}
async function updateAction(fn) {
  $('update-panel').hidden = false;
  try { renderUpdate(await fn()); } catch { $('update-message').textContent = '更新操作失败，请重试。'; }
}

function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function status(message, online = false) { $('status').textContent = message; $('status-dot').classList.toggle('online', online); }
function setBusy(value) {
  busy = value;
  for (const id of ['share', 'join', 'refresh', 'server', 'ice', 'relay-address', 'relay-user', 'relay-password', 'advanced-network', 'remote-id', 'remote-password', 'host-password', 'unattended']) $(id).disabled = value;
  $('auto-start').disabled = value || !canAutoStart || !$('unattended').checked;
  document.querySelectorAll('.screen-card input').forEach(input => { input.disabled = value; });
  for (const id of ['relay-address', 'relay-user', 'relay-password']) $(id).disabled = value || $('advanced-network').checked;
  $('stop').hidden = !value;
}
const showError = error => notice(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
async function action(fn) { try { await fn(); } catch (error) { showError(error); } }

async function refreshScreens() {
  localScreens = await api.screens();
  $('screens').replaceChildren();
  for (const [index, screen] of localScreens.entries()) {
    const label = document.createElement('label'); label.className = 'screen-card';
    const image = document.createElement('img'); image.src = screen.thumbnail; image.alt = `屏幕 ${index + 1} 预览`;
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = screen.id;
    input.checked = preferredDisplays.length ? preferredDisplays.includes(screen.displayId) : index < 2;
    input.setAttribute('aria-label', `共享屏幕 ${index + 1}`);
    input.addEventListener('change', () => {
      if (document.querySelectorAll('.screen-card input:checked').length > 2) { input.checked = false; notice('最多同时共享两块屏幕。'); }
    });
    const title = document.createElement('span'); title.textContent = `屏幕 ${index + 1} · ${screen.name}`;
    const size = document.createElement('small'); size.textContent = `${screen.width} × ${screen.height}`;
    label.append(image, input, title, size); $('screens').append(label);
  }
  if (!localScreens.length) $('screens').textContent = '未找到显示器，请确认 Windows 桌面已登录。';
}

function sendData(message) {
  if (channel?.readyState !== 'open') return false;
  if (['move', 'button', 'wheel', 'release'].includes(message.type)) message.sequence = ++inputSequence;
  // 移动只保留新位置，不让丢包重传堵住点击、抬键和心跳。
  if (message.type === 'move' && motionChannel?.readyState === 'open') {
    if (motionChannel.bufferedAmount > 2048) return false;
    motionChannel.send(JSON.stringify(message)); return true;
  }
  // 移动事件可以丢弃，按键与抬起事件必须保留；严重拥塞时主动断开并释放按键。
  if (channel.bufferedAmount > 32768 && message.type === 'move') return false;
  if (channel.bufferedAmount > 262144) { void stopAll('控制通道拥塞，已断开以释放按键'); return false; }
  channel.send(JSON.stringify(message)); return true;
}
function release() { if (role === 'viewer') sendData({ type: 'release' }); }
function clearPeer() {
  epoch++;
  clearTimeout(restartTimer); toolsUI.clear();
  restartAttempts = 0; restarting = false; adaptiveState = null; adaptiveTick = 0; hostDisplays = [];
  document.body.classList.remove('toolbar-hidden');
  clearInterval(statsTimer); clearInterval(heartbeatTimer); clearTimeout(connectionTimer); clearTimeout(disconnectedTimer);
  release();
  closeSecondScreen();
  if (pc) { pc.onconnectionstatechange = null; pc.onicecandidate = null; pc.ontrack = null; pc.close(); pc = null; }
  channel = motionChannel = null; inputSequence = lastMotionSequence = 0;
  hostScreenIds = []; visibleScreenIds = null;
  for (const stream of captureStreams) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
  captureStreams = []; candidates = []; remoteScreens = []; lastStats.clear();
  sessionId = pendingId = null;
  $('request').hidden = $('host-active').hidden = $('session').hidden = true;
  $('setup').hidden = false;
  $('videos').replaceChildren();
  document.body.classList.remove('session-mode', 'session-fullscreen');
  $('separate-screen').disabled = true;
  if (fullScreen) { fullScreen = false; void api.fullscreen(false); $('fullscreen').textContent = '全屏'; }
}
async function stopAll(message = '连接已结束') {
  clearPeer();
  sharing = false; role = null;
  document.body.classList.remove('sharing-mode');
  await api.disconnect();
  $('sharing-mode-label').textContent = '尚未开启共享，请配置服务器后开启共享。';
  $('copy-invite').disabled = true;
  setBusy(false); status('未连接'); notice(message);
}
async function endSession(message) {
  if (!sharing) return stopAll(message);
  clearPeer();
  await api.leave();
  status('共享就绪 · 等待连接', true); notice(message);
}
async function start(roleName) {
  if (busy) return;
  role = roleName;
  unattended = role === 'host' && $('unattended').checked;
  quality = $('quality').value;
  setBusy(true); status('连接服务器…'); notice('正在连接…');
  try {
    const ice = $('advanced-network').checked ? $('ice').value.trim() : await api.relay({ server: $('server').value.trim(), address: $('relay-address').value, username: $('relay-user').value, password: $('relay-password').value });
    await api.connect({ url: $('server').value.trim(), ice, role,
      screens: [...document.querySelectorAll('.screen-card input:checked')].map(input => input.value),
      id: $('remote-id').value.replace(/\s/g, ''), password: $(role === 'host' ? 'host-password' : 'remote-password').value,
      unattended, autoStart: unattended && $('auto-start').checked });
    localStorage.setItem('ydesk-server', $('server').value.trim());
    $('server-summary').textContent = $('server').value.trim();
    $('network-settings').open = false;
  } catch (error) { await stopAll(); showError(error); }
}

async function applyQuality(name) {
  if (!qualities[name] || !pc) return;
  const preset = { ...qualities[name], ...(name === 'auto' && adaptiveState ? { bitrate: adaptiveState.bitrate, fps: adaptiveState.fps } : {}) };
  const activeCount = Math.max(1, visibleScreenIds?.length || hostScreenIds.length);
  for (const [index, sender] of pc.getSenders().entries()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    sender.track.contentHint = preset.hint;
    const source = hostDisplays[index] || sender.track.getSettings();
    const captureSize = YDeskPerformance.captureSize(source, preset);
    // 降低采集帧率以减少编码前的工作量；码率预算由当前显示的屏幕共用。
    const current = sender.track.getSettings();
    if (current.width !== captureSize.width || current.height !== captureSize.height || current.frameRate !== preset.fps) {
      try { await sender.track.applyConstraints({ width: { ideal: captureSize.width }, height: { ideal: captureSize.height }, frameRate: { ideal: preset.fps, max: preset.fps } }); } catch { /* 不支持动态约束时由编码器限帧缩放。 */ }
    }
    const settings = sender.track.getSettings();
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    params.encodings[0].active = !visibleScreenIds || visibleScreenIds.includes(hostScreenIds[index]);
    params.encodings[0].maxBitrate = Math.floor(preset.bitrate / activeCount);
    params.encodings[0].maxFramerate = preset.fps;
    params.encodings[0].scaleResolutionDownBy = Math.max(1, (settings.width || 1920) / preset.width, (settings.height || 1080) / preset.height);
    params.degradationPreference = ['smooth', 'economy'].includes(name) ? 'maintain-framerate' : 'balanced';
    await sender.setParameters(params);
  }
}

function queueQuality(name) {
  if (!qualities[name]) return Promise.resolve();
  quality = name;
  const token = epoch;
  qualityQueue = qualityQueue.catch(() => {}).then(() => { if (token === epoch && name === quality) return applyQuality(name); });
  return qualityQueue;
}

function receiveInput(event, token, motionOnly = false) {
  if (token !== epoch || typeof event.data !== 'string' || event.data.length > 16384) return;
  if (Date.now() - controlWindow > 1000) { controlWindow = Date.now(); controlCount = 0; }
  if (++controlCount > 500) { void stopAll('输入频率异常，已停止共享'); return; }
  try {
    const message = JSON.parse(event.data);
    if (!motionOnly && toolsUI.control(message)) return;
    if (role !== 'host') return;
    if (motionOnly && message.type !== 'move') return;
    if (message.type === 'quality') { void action(() => queueQuality(message.value)); return; }
    if (message.type === 'view') {
      if (!Array.isArray(message.screens) || !message.screens.length || message.screens.length > 2 || message.screens.some(id => !hostScreenIds.includes(id))) return;
      visibleScreenIds = [...new Set(message.screens)]; void action(() => queueQuality(quality)); return;
    }
    if (Number.isSafeInteger(message.sequence)) {
      if (message.type === 'move' && message.sequence <= lastMotionSequence) return;
      lastMotionSequence = Math.max(lastMotionSequence, message.sequence);
    } else if (motionOnly) return;
    api.input(message);
  } catch { /* 忽略无效数据，不影响当前视频。 */ }
}

function attachChannel(dataChannel, token) {
  if (toolsUI.attach(dataChannel)) return;
  if (dataChannel.label === 'motion' && !motionChannel) {
    motionChannel = dataChannel;
    motionChannel.onmessage = event => receiveInput(event, token, true);
    return;
  }
  if (dataChannel.label !== 'control' || channel) { dataChannel.close(); return; }
  channel = dataChannel;
  channel.onopen = () => {
    if (token !== epoch) return;
    toolsUI.start(role, pc);
    if (role === 'viewer') {
      sendData({ type: 'quality', value: $('quality').value });
      updateLayout();
      heartbeatTimer = setInterval(() => sendData({ type: 'heartbeat' }), 1000);
    }
  };
  channel.onclose = () => { if (token === epoch) void endSession('对方已断开，等待下次连接'); };
  channel.onmessage = event => receiveInput(event, token);
}

async function createPeer(message) {
  clearPeer();
  role = message.role; sessionId = message.session;
  hostDisplays = message.screens;
  const token = epoch;
  const peer = new RTCPeerConnection({ iceServers: message.ice, bundlePolicy: 'max-bundle' });
  pc = peer;
  peer.onicecandidate = event => { if (event.candidate && token === epoch) void action(() => api.signal({ type: 'candidate', candidate: event.candidate.toJSON() })); };
  peer.onconnectionstatechange = () => {
    if (token !== epoch) return;
    if (peer.connectionState === 'connected') {
      clearTimeout(connectionTimer); clearTimeout(disconnectedTimer);
      clearTimeout(restartTimer); restarting = false; restartAttempts = 0;
      if (role === 'viewer') void action(async () => { await api.recordConnected(); await toolsUI.devices(); });
      status(role === 'host' ? '共享中 · 对方可控制' : '已连接 · 加密传输', true);
      notice(role === 'host' ? '随时点击停止共享，或按 Ctrl + Alt + F12。' : '点击远程画面后，鼠标和键盘将发送到对方电脑。');
    } else if (peer.connectionState === 'failed') {
      if (role === 'host') void recoverPeer(peer, token);
      else { clearTimeout(disconnectedTimer); disconnectedTimer = setTimeout(() => { if (token === epoch) void endSession('连接恢复失败，请检查网络与中继'); }, 28000); }
    }
    else if (peer.connectionState === 'disconnected') {
      status('网络中断，等待恢复…');
      if (role === 'host') api.input({ type: 'release' });
      clearTimeout(disconnectedTimer);
      disconnectedTimer = setTimeout(() => { if (token !== epoch) return; if (role === 'host') void recoverPeer(peer, token); else void endSession('网络未恢复，请重新连接'); }, role === 'host' ? 3000 : 28000);
    }
  };
  connectionTimer = setTimeout(() => { if (token === epoch) void endSession('建立视频连接超时。请检查防火墙和 TURN 配置。'); }, 30000);
  if (role === 'host') {
    $('setup').hidden = true;
    $('host-active').hidden = false;
    status('已允许，正在共享…', true);
    attachChannel(peer.createDataChannel('control', { ordered: true }), token);
    attachChannel(peer.createDataChannel('motion', { ordered: false, maxRetransmits: 0 }), token);
    hostScreenIds = message.screens.map(display => display.id);
    const initial = qualities[quality] || qualities.auto;
    for (const display of message.screens) {
      const id = await api.capture(display.id);
      if (token !== epoch) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: id,
        maxWidth: display.width, maxHeight: display.height, maxFrameRate: 60
      } } });
      if (token !== epoch) { stream.getTracks().forEach(track => track.stop()); return; }
      captureStreams.push(stream);
      const track = stream.getVideoTracks()[0];
      const size = YDeskPerformance.captureSize(display, initial);
      await track.applyConstraints({ width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: initial.fps, max: initial.fps } }).catch(() => {});
      track.onended = () => { if (token === epoch) void stopAll('屏幕采集已停止，请重新开启共享'); };
      peer.addTrack(track, stream);
    }
    // 浏览器负责硬件加速与编解码协商，不强制不受设备支持的编码器。
    await peer.setLocalDescription(await peer.createOffer());
    if (token !== epoch) return;
    const screens = message.screens.map((display, index) => ({ id: display.id, name: `屏幕 ${index + 1}`, width: display.width, height: display.height,
      mid: peer.getTransceivers()[index].mid }));
    await api.signal({ type: 'offer', sdp: peer.localDescription.sdp, screens });
    await queueQuality(quality);
  } else {
    $('setup').hidden = true; $('session').hidden = false;
    document.body.classList.add('session-mode');
    status('正在建立视频连接…');
    peer.ondatachannel = event => { if (token === epoch) attachChannel(event.channel, token); };
    peer.ontrack = event => {
      if (token !== epoch) return;
      // 低延迟偏好由浏览器在网络允许时采用，不强行积攒播放缓冲。
      if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
      const display = remoteScreens.find(screen => screen.mid === event.transceiver.mid);
      if (display) addVideo(display, new MediaStream([event.track]));
    };
  }
  startStats(peer, token);
}

async function recoverPeer(peer, token) {
  if (token !== epoch || restarting || role !== 'host') return;
  if (restartAttempts >= 2) { await endSession('网络恢复失败，请检查中继或重新连接'); return; }
  restarting = true; restartAttempts++; api.input({ type: 'release' });
  status(`网络恢复中 · 第 ${restartAttempts} 次重试`);
  try {
    await peer.setLocalDescription(await peer.createOffer({ iceRestart: true }));
    if (token !== epoch) return;
    const screens = hostDisplays.map((display, index) => ({ id: display.id, name: `屏幕 ${index + 1}`, width: display.width, height: display.height, mid: peer.getTransceivers()[index].mid }));
    await api.signal({ type: 'offer', sdp: peer.localDescription.sdp, screens });
    if (token !== epoch) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { restarting = false; if (token !== epoch) return; if (peer.connectionState !== 'connected') void recoverPeer(peer, token); else restartAttempts = 0; }, 12000);
  } catch { if (token === epoch) { restarting = false; await endSession('重新协商失败，请重新连接'); } }
}

async function receiveSignal(data) {
  if (!pc) return;
  const peer = pc, token = epoch;
  if (data.type === 'candidate') {
    if (peer.remoteDescription) await peer.addIceCandidate(data.candidate); else candidates.push(data.candidate);
    return;
  }
  if (data.type === 'offer' && role === 'viewer') {
    if (!Array.isArray(data.screens) || !data.screens.length || data.screens.length > 2 || data.screens.some(screen =>
      typeof screen.id !== 'string' || screen.id.length > 100 || typeof screen.mid !== 'string' || typeof screen.name !== 'string')) throw new Error('远端屏幕信息错误');
    if (!remoteScreens.length) {
      remoteScreens = data.screens;
      $('layout').replaceChildren(new Option('双屏并排', 'all'), ...remoteScreens.map(display => new Option(display.name, display.id)));
    }
    await peer.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    if (token !== epoch) return;
    await api.signal({ type: 'answer', sdp: peer.localDescription.sdp });
  } else if (data.type === 'answer' && role === 'host') {
    await peer.setRemoteDescription({ type: 'answer', sdp: data.sdp });
  } else return;
  for (const candidate of candidates) { if (token === epoch) await peer.addIceCandidate(candidate); }
  candidates = [];
}

function pointerPosition(video, event) {
  const rect = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale, height = video.videoHeight * scale;
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}
function applyScale() {
  const original = $('scale').value === 'original';
  const surfaces = [...$('videos').children, ...(detachedSurface ? [detachedSurface] : [])];
  for (const surface of surfaces) {
    surface.classList.toggle('original-size', original);
    const video = surface.querySelector('video');
    video.style.width = original ? `${video.dataset.width || video.videoWidth}px` : '';
    video.style.height = original ? `${video.dataset.height || video.videoHeight}px` : '';
  }
  if (secondWindow && !secondWindow.closed) secondWindow.document.getElementById('screen-scale').value = $('scale').value;
}
function swapScreens() {
  if (!detachedSurface || !secondWindow || secondWindow.closed) return;
  release();
  const main = [...$('videos').children].find(surface => surface !== detachedSurface);
  if (!main) return;
  const old = detachedSurface; detachedSurface = main;
  $('videos').append(old); secondWindow.document.getElementById('screen-content').append(main); main.hidden = false;
  secondWindow.document.getElementById('screen-title').textContent = main.querySelector('.screen-label').textContent;
  $('layout').value = old.dataset.screen; updateLayout(); applyScale();
  for (const surface of [old, main]) void surface.querySelector('video').play().catch(showError);
}
async function refreshLocalDisplays() {
  const displays = await api.localDisplays();
  const selects = [$('local-display'), secondWindow && !secondWindow.closed ? secondWindow.document.getElementById('screen-display') : null];
  for (const select of selects) if (select) select.replaceChildren(new Option('移动到显示器…', ''), ...displays.map((display, index) => new Option(`${index + 1} · ${display.name}${display.primary ? '（主屏）' : ''}`, display.id)));
}
function bindToolbar(targetWindow, selector, fullscreen) {
  let timer;
  const doc = targetWindow.document, bar = doc.querySelector(selector);
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => {
    timer = null;
    if (fullscreen() && !bar.matches(':hover') && !bar.contains(doc.activeElement)) doc.body.classList.add('toolbar-hidden');
  }, 2000); };
  const show = () => { doc.body.classList.remove('toolbar-hidden'); arm(); };
  doc.addEventListener('pointermove', event => { if (event.clientY < 65) show(); else if (!timer) arm(); });
  bar.addEventListener('focusin', show); bar.addEventListener('pointerenter', show); bar.addEventListener('pointerleave', arm);
  targetWindow.addEventListener('beforeunload', () => clearTimeout(timer));
  return show;
}
function addVideo(display, stream) {
  const surface = document.createElement('div'); surface.className = 'remote-screen'; surface.tabIndex = 0;
  surface.dataset.screen = display.id; surface.setAttribute('aria-label', `${display.name}，点击后可远程控制`);
  const label = document.createElement('div'); label.className = 'screen-label'; label.textContent = display.name;
  const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true; video.srcObject = stream;
  video.dataset.width = display.width; video.dataset.height = display.height;
  surface.append(label, video); $('videos').append(surface);
  void video.play().catch(showError);
  $('separate-screen').disabled = remoteScreens.length < 2 || $('videos').children.length < 2;
  let lastMove = 0, pointerHeld = false;
  const point = event => pointerPosition(video, event);
  video.addEventListener('pointerdown', event => {
    if (!allowControl || event.button > 2) return;
    const position = point(event); if (!position?.inside) return;
    event.preventDefault(); surface.focus(); video.setPointerCapture(event.pointerId);
    pointerHeld = true;
    sendData({ type: 'button', screen: display.id, ...position, button: event.button, down: true });
  });
  video.addEventListener('pointerup', event => {
    if (!allowControl || event.button > 2) return;
    const position = point(event); if (position) sendData({ type: 'button', screen: display.id, ...position, button: event.button, down: false });
    pointerHeld = false;
    if (video.hasPointerCapture(event.pointerId)) video.releasePointerCapture(event.pointerId);
  });
  // 正常抬鼠标不能释放仍被用户按住的 Ctrl / Shift；只在异常失去捕获时全部释放。
  video.addEventListener('lostpointercapture', () => { if (pointerHeld) { pointerHeld = false; release(); } });
  video.addEventListener('pointercancel', () => { pointerHeld = false; release(); });
  video.addEventListener('pointermove', event => {
    if (!allowControl || surface.ownerDocument.activeElement !== surface || performance.now() - lastMove < 16) return;
    const position = point(event); if (!position || !position.inside && !video.hasPointerCapture(event.pointerId)) return;
    lastMove = performance.now(); sendData({ type: 'move', screen: display.id, ...position });
  });
  video.addEventListener('wheel', event => {
    if (!allowControl || surface.ownerDocument.activeElement !== surface) return;
    const position = point(event); if (!position?.inside) return;
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 600 : event.deltaY;
    sendData({ type: 'wheel', screen: display.id, ...position, delta: -Math.round(delta) });
  }, { passive: false });
  video.addEventListener('contextmenu', event => event.preventDefault());
  for (const type of ['keydown', 'keyup']) surface.addEventListener(type, event => {
    if (!allowControl) return;
    event.preventDefault(); event.stopPropagation();
    if (event.ctrlKey && event.altKey && event.code === 'Escape') { release(); surface.blur(); notice('已释放键盘，点击画面可继续控制。'); return; }
    if (event.code === 'F12' && event.ctrlKey && event.altKey) return;
    sendData({ type: 'key', code: event.code, down: type === 'keydown' });
  });
  surface.addEventListener('blur', release);
  updateLayout();
  applyScale();
}
function updateLayout() {
  release();
  const value = $('layout').value;
  for (const surface of $('videos').children) surface.hidden = value !== 'all' && surface.dataset.screen !== value;
  $('videos').classList.toggle('single', value !== 'all' || remoteScreens.length === 1 || Boolean(detachedSurface));
  const screens = remoteScreens.filter(display => value === 'all' || display.id === value || display.id === detachedSurface?.dataset.screen).map(display => display.id);
  if (screens.length) sendData({ type: 'view', screens });
}

function closeSecondScreen() {
  const child = secondWindow; secondWindow = null;
  secondFullscreen = false;
  if (detachedSurface) {
    $('videos').append(detachedSurface); detachedSurface = null;
    $('layout').value = 'all'; updateLayout();
  }
  if (child && !child.closed) child.close();
  $('separate-screen').textContent = '双屏分窗';
  $('swap-screens').disabled = true;
}
function separateScreens() {
  if (secondWindow && !secondWindow.closed) { closeSecondScreen(); return; }
  if (remoteScreens.length < 2) return;
  secondWindow = window.open('screen.html', 'ydesk-second-screen');
  if (!secondWindow) throw new Error('无法打开第二屏窗口，请重新连接后重试');
}
window.addEventListener('message', event => {
  if (!secondWindow || event.source !== secondWindow || event.data !== 'ydesk-screen-ready') return;
  const child = secondWindow;
  const surface = [...$('videos').children].find(item => item.dataset.screen === remoteScreens[1]?.id);
  if (!surface) { closeSecondScreen(); return; }
  // 同源子窗口直接复用现有视频元素，不增加 WebRTC 连接或重复编码。
  detachedSurface = surface; surface.hidden = false;
  child.document.getElementById('screen-content').append(surface);
  child.document.getElementById('screen-title').textContent = remoteScreens[1].name;
  child.document.getElementById('screen-return').addEventListener('click', closeSecondScreen);
  const fullscreenButton = child.document.getElementById('screen-fullscreen');
  fullscreenButton.addEventListener('click', () => void action(async () => {
    secondFullscreen = await api.screenFullscreen(!secondFullscreen);
    fullscreenButton.textContent = secondFullscreen ? '退出全屏' : '全屏';
  }));
  child.addEventListener('blur', release);
  child.document.getElementById('screen-scale').value = $('scale').value;
  child.document.getElementById('screen-scale').addEventListener('change', event => { $('scale').value = event.target.value; applyScale(); });
  child.document.getElementById('screen-display').addEventListener('change', event => void action(() => api.placeScreen({ target: 'second', displayId: Number(event.target.value) })));
  child.document.getElementById('screen-swap').addEventListener('click', swapScreens);
  bindToolbar(child, '.screen-window-toolbar', () => secondFullscreen);
  void refreshLocalDisplays(); applyScale();
  child.addEventListener('beforeunload', () => { if (secondWindow === child) closeSecondScreen(); });
  $('layout').value = remoteScreens[0].id; updateLayout();
  void surface.querySelector('video').play().catch(showError);
  $('separate-screen').textContent = '合并双屏';
  $('swap-screens').disabled = false;
  notice('屏幕 2 已在独立窗口打开，可拖动到另一台显示器并全屏。');
});

function startStats(peer, token) {
  let collecting = false;
  statsTimer = setInterval(async () => {
    if (collecting || token !== epoch) return;
    collecting = true;
    try {
      const reports = await peer.getStats();
      if (token !== epoch) return;
      const videos = [], samples = []; let rtt = null, route = '', bandwidth = null, cpu = false;
      reports.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const previous = lastStats.get(report.id);
          const elapsed = previous ? (report.timestamp - previous.time) / 1000 : 0;
          const bitrate = elapsed > 0 ? (report.bytesReceived - previous.bytes) * 8 / elapsed / 1e6 : 0;
          const fps = elapsed > 0 ? (report.framesDecoded - previous.frames) / elapsed : 0;
          const emitted = (report.jitterBufferEmittedCount || 0) - (previous?.emitted || 0);
          const bufferMs = emitted > 0 ? Math.round(((report.jitterBufferDelay || 0) - (previous?.buffer || 0)) / emitted * 1000) : 0;
          lastStats.set(report.id, { time: report.timestamp, bytes: report.bytesReceived, frames: report.framesDecoded || 0, emitted: report.jitterBufferEmittedCount || 0, buffer: report.jitterBufferDelay || 0 });
          const codec = reports.get(report.codecId)?.mimeType?.replace('video/', '') || '';
          videos.push(`${report.frameWidth || '—'}×${report.frameHeight || '—'} ${Math.round(fps)}fps ${bitrate.toFixed(1)}Mbps ${codec} 缓冲 ${bufferMs}ms`);
          samples.push({ width: report.frameWidth, height: report.frameHeight, fps: Math.round(fps), bitrateMbps: +bitrate.toFixed(2), bufferMs, codec,
            packetsLost: report.packetsLost, framesDropped: report.framesDropped, decodeMs: report.framesDecoded ? Math.round(report.totalDecodeTime / report.framesDecoded * 1000) : null });
        }
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          cpu ||= report.qualityLimitationReason === 'cpu';
          samples.push({ width: report.frameWidth, height: report.frameHeight, fps: report.framesPerSecond, limitation: report.qualityLimitationReason || '不可用',
            encodeMs: report.framesEncoded ? Math.round(report.totalEncodeTime / report.framesEncoded * 1000) : null });
        }
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          const pair = reports.get(report.selectedCandidatePairId);
          if (pair?.currentRoundTripTime !== undefined) rtt = Math.round(pair.currentRoundTripTime * 1000);
          route = YDeskPerformance.route(reports, pair);
          bandwidth = pair?.availableOutgoingBitrate;
        }
      });
      $('stats').textContent = videos.length ? videos.join(' / ') : '等待视频数据…';
      $('session-detail').textContent = `${remoteScreens.length} 个屏幕 · ${route || '协商中'} · RTT ${rtt === null ? '—' : rtt + ' ms'}`;
      const snapshot = { time: new Date().toISOString(), role, route, rttMs: rtt, bandwidth: bandwidth || null, videos: samples };
      toolsUI.stats(snapshot);
      if (role === 'host' && quality === 'auto' && ++adaptiveTick % 2 === 0) {
        const next = YDeskPerformance.adaptive(adaptiveState, { bandwidth, cpu }, Date.now());
        const applied = peer.getSenders().reduce((sum, sender) => { const encoding = sender.getParameters().encodings?.[0]; return sum + (encoding?.active ? encoding.maxBitrate || 0 : 0); }, 0);
        const changed = !adaptiveState || next.fps !== adaptiveState.fps || Math.abs(next.bitrate - applied) > Math.max(1, applied) * 0.15;
        adaptiveState = next; if (changed) await queueQuality('auto');
      }
    } catch { /* 连接关闭时忽略最后一次统计。 */ }
    finally { collecting = false; }
  }, 1000);
}

async function onEvent(message) {
  switch (message.type) {
    case 'local-displays-changed': await refreshLocalDisplays(); break;
    case 'second-fullscreen':
      secondFullscreen = message.enabled;
      secondWindow?.document.body.classList.toggle('native-fullscreen', message.enabled);
      if (secondWindow && !secondWindow.closed) secondWindow.document.getElementById('screen-fullscreen').textContent = secondFullscreen ? '退出全屏' : '全屏';
      break;
    case 'fullscreen': setFullscreenUI(message.enabled); break;
    case 'update-state': renderUpdate(message.state); break;
    case 'registered':
      sharing = true; $('copy-invite').disabled = false;
      unattended = Boolean(message.unattended);
      document.body.classList.add('sharing-mode');
      $('device-id').textContent = message.id.replace(/(\d{3})(?=\d)/g, '$1 ');
      $('sharing-mode-label').textContent = unattended ? '无人值守已开启：密码正确即可连接' : '连接时需要本机允许';
      status('共享就绪 · 等待连接', true); notice(unattended ? '无人值守已开启。关闭窗口后继续在系统托盘运行；点击停止共享可暂停自动共享。' : '将设备码和自设密码告知对方，收到请求后确认身份。'); break;
    case 'request':
      pendingId = message.session; $('request').hidden = Boolean(message.unattended);
      $('accept').disabled = false; status(message.unattended ? '密码验证通过，正在自动连接…' : '收到连接请求', true); break;
    case 'waiting': pendingId = message.session; status('等待连接…'); notice('无人值守将自动连接；普通模式等待对方确认。'); break;
    case 'ready': if (message.session === pendingId) await createPeer(message); break;
    case 'signal': if (message.session === sessionId) await receiveSignal(message.data); break;
    case 'ended':
      if (message.session === sessionId || message.session === pendingId) await endSession(message.reason);
      break;
    case 'offline': await stopAll(message.message); break;
    case 'reconnecting':
      clearPeer(); role = 'host'; sharing = true; unattended = true; setBusy(true);
      $('copy-invite').disabled = true;
      $('sharing-mode-label').textContent = '共享已暂停，正在等待恢复连接。';
      status('无人值守 · 等待恢复'); notice(message.message); break;
    case 'error':
      if (message.fatal || !sharing && !sessionId) await stopAll(message.message);
      notice(message.message, true); break;
    case 'input-error': notice(message.message, true); break;
    case 'notice': notice(message.message); break;
  }
}
api.onEvent(message => {
  eventQueue = eventQueue.then(() => onEvent(message)).catch(async error => {
    if (unattended && sharing) await endSession(error.message); else await stopAll();
    showError(error);
  });
});
$('share').addEventListener('click', () => void start('host'));
$('check-update').addEventListener('click', () => void updateAction(() => api.updateCheck()));
$('download-update').addEventListener('click', () => void updateAction(() => api.updateDownload()));
$('install-update').addEventListener('click', () => void updateAction(() => api.updateInstall()));
$('update-page').addEventListener('click', () => void action(() => api.updatePage()));
$('dismiss-update').addEventListener('click', () => { $('update-panel').hidden = true; });
$('join-form').addEventListener('submit', event => { event.preventDefault(); void start('viewer'); });
$('refresh').addEventListener('click', () => void action(refreshScreens));
$('stop').addEventListener('click', () => void action(() => stopAll()));
$('accept').addEventListener('click', () => void action(async () => {
  $('accept').disabled = true;
  try { await api.approve({ session: pendingId, allow: true }); $('request').hidden = true; }
  finally { $('accept').disabled = false; }
}));
$('reject').addEventListener('click', () => void action(() => api.approve({ session: pendingId, allow: false })));
$('unattended').addEventListener('change', () => {
  $('auto-start').disabled = !canAutoStart || !$('unattended').checked;
  if (!$('unattended').checked) $('auto-start').checked = false;
});
$('copy-device-id').addEventListener('click', () => void action(async () => {
  await api.copyDeviceId();
  notice('本机设备码已复制。开启共享后，对方才能连接。');
}));
$('copy-invite').addEventListener('click', () => void action(async () => {
  await api.copyInvite();
  notice('设备码和服务器已复制。请单独告知对方连接密码。');
}));
$('layout').addEventListener('change', () => {
  const value = $('layout').value; closeSecondScreen(); $('layout').value = value; updateLayout();
});
$('separate-screen').addEventListener('click', () => void action(separateScreens));
$('swap-screens').addEventListener('click', swapScreens);
$('scale').addEventListener('change', applyScale);
$('local-display').addEventListener('change', event => { if (event.target.value) void action(() => api.placeScreen({ target: 'main', displayId: Number(event.target.value) })); });
$('quality').addEventListener('change', () => { sendData({ type: 'quality', value: $('quality').value }); notice('画质上限已调整，实际帧率与分辨率随网络和画面变化。'); });
$('control-toggle').addEventListener('click', () => {
  release(); allowControl = !allowControl;
  $('control-toggle').textContent = allowControl ? '控制已开启' : '仅观看';
  $('control-toggle').setAttribute('aria-pressed', String(allowControl));
});
function setFullscreenUI(enabled) {
  fullScreen = enabled;
  document.body.classList.toggle('session-fullscreen', enabled && role === 'viewer');
  $('fullscreen').textContent = enabled ? '退出全屏' : '全屏';
  showToolbar();
}
const showToolbar = bindToolbar(window, '.session-toolbar', () => fullScreen);
$('fullscreen').addEventListener('click', () => void action(async () => setFullscreenUI(await api.fullscreen(!fullScreen))));
$('disconnect-session').addEventListener('click', () => void action(() => stopAll()));
$('advanced-network').addEventListener('change', () => {
  const advanced = $('advanced-network').checked;
  $('advanced-ice').hidden = !advanced;
  for (const id of ['relay-address', 'relay-user', 'relay-password']) $(id).disabled = advanced || busy;
});
$('send-text').addEventListener('click', () => {
  if (!allowControl) { notice('当前为仅观看模式，请先开启控制。'); return; }
  if (sendData({ type: 'text', text: $('remote-text').value })) { $('remote-text').value = ''; notice('文本已发送到远端当前输入位置。'); }
});
window.addEventListener('blur', release);
window.addEventListener('beforeunload', () => { clearPeer(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
void action(async () => {
  qualities = await api.qualities();
  const settings = await api.settings();
  $('device-id').textContent = settings.id.replace(/(\d{3})(?=\d)/g, '$1 ');
  $('copy-device-id').disabled = false;
  renderUpdate(await api.updateState());
  canAutoStart = settings.canAutoStart; preferredDisplays = settings.displayIds;
  $('server').value = settings.url || localStorage.getItem('ydesk-server') || 'wss://desk.yinsane.xyz';
  $('server-summary').textContent = $('server').value;
  $('ice').value = settings.ice.length ? JSON.stringify(settings.ice, null, 2) : '';
  // 识别常见的 coturn 配置并回填表单；其他自定义组合保留在高级编辑器。
  const turn = settings.ice.find(item => [].concat(item.urls).some(url => url.startsWith('turn:')));
  let simple = !settings.ice.length;
  if (turn) {
    const address = [].concat(turn.urls).find(url => url.startsWith('turn:')).slice(5).split('?')[0];
    const generated = await api.relay({ server: $('server').value, address, username: turn.username, password: turn.credential }).catch(() => null);
    const normalized = list => JSON.stringify(list.map(item => ({ urls: [].concat(item.urls).sort(), username: item.username || '', credential: item.credential || '' })).sort((a, b) => a.urls[0].localeCompare(b.urls[0])));
    simple = generated && normalized(generated) === normalized(settings.ice);
    if (simple) { $('relay-address').value = address; $('relay-user').value = turn.username; $('relay-password').value = turn.credential; }
  }
  $('advanced-network').checked = !simple;
  $('advanced-network').dispatchEvent(new Event('change'));
  $('unattended').checked = settings.unattended;
  $('auto-start').checked = canAutoStart && settings.autoStart;
  $('auto-start').disabled = !canAutoStart || !settings.unattended;
  if (!canAutoStart) $('auto-start-hint').textContent = '登录自启请使用安装版；当前版本仍可在系统托盘保持无人值守。';
  if (settings.passwordSaved) $('host-password').placeholder = '已保存密码；留空沿用，输入可修改';
  await refreshScreens();
  await toolsUI.init(); await refreshLocalDisplays();
  if (settings.autoShare) { role = 'host'; unattended = true; sharing = true; setBusy(true); await api.resume(); }
});

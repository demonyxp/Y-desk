'use strict';

const $ = id => document.getElementById(id);
const api = window.ydesk;
let pc, channel, role, sessionId, pendingId, captureStreams = [], localScreens = [], remoteScreens = [];
let epoch = 0, busy = false, sharing = false, allowControl = true, fullScreen = false;
let qualities, candidates = [], statsTimer, heartbeatTimer, connectionTimer, disconnectedTimer;
let quality = 'balanced', lastStats = new Map(), eventQueue = Promise.resolve(), controlCount = 0, controlWindow = 0;
let unattended = false, canAutoStart = false, preferredDisplays = [];

function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function status(message, online = false) { $('status').textContent = message; $('status-dot').classList.toggle('online', online); }
function setBusy(value) {
  busy = value;
  for (const id of ['share', 'join', 'refresh', 'server', 'ice', 'remote-id', 'remote-password', 'host-password', 'unattended']) $(id).disabled = value;
  $('auto-start').disabled = value || !canAutoStart || !$('unattended').checked;
  document.querySelectorAll('.screen-card input').forEach(input => { input.disabled = value; });
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
  // 移动事件可以丢弃，按键与抬起事件必须保留；严重拥塞时主动断开并释放按键。
  if (channel.bufferedAmount > 32768 && message.type === 'move') return false;
  if (channel.bufferedAmount > 262144) { void stopAll('控制通道拥塞，已断开以释放按键'); return false; }
  channel.send(JSON.stringify(message)); return true;
}
function release() { if (role === 'viewer') sendData({ type: 'release' }); }
function clearPeer() {
  epoch++;
  clearInterval(statsTimer); clearInterval(heartbeatTimer); clearTimeout(connectionTimer); clearTimeout(disconnectedTimer);
  release();
  if (pc) { pc.onconnectionstatechange = null; pc.onicecandidate = null; pc.ontrack = null; pc.close(); pc = null; }
  channel = null;
  for (const stream of captureStreams) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
  captureStreams = []; candidates = []; remoteScreens = []; lastStats.clear();
  sessionId = pendingId = null;
  $('request').hidden = $('host-active').hidden = $('session').hidden = true;
  $('setup').hidden = false;
  $('videos').replaceChildren();
  document.body.classList.remove('session-mode');
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
    await api.connect({ url: $('server').value.trim(), ice: $('ice').value.trim(), role,
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
  quality = name;
  const preset = qualities[name];
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    sender.track.contentHint = preset.hint;
    const settings = sender.track.getSettings();
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    params.encodings[0].maxBitrate = preset.bitrate;
    params.encodings[0].maxFramerate = preset.fps;
    params.encodings[0].scaleResolutionDownBy = Math.max(1, (settings.width || 1920) / preset.width, (settings.height || 1080) / preset.height);
    params.degradationPreference = name === 'smooth' ? 'maintain-framerate' : 'maintain-resolution';
    await sender.setParameters(params);
  }
}

function attachChannel(dataChannel, token) {
  if (dataChannel.label !== 'control' || channel) { dataChannel.close(); return; }
  channel = dataChannel;
  channel.onopen = () => {
    if (token !== epoch) return;
    if (role === 'viewer') {
      sendData({ type: 'quality', value: $('quality').value });
      heartbeatTimer = setInterval(() => sendData({ type: 'heartbeat' }), 1000);
    }
  };
  channel.onclose = () => { if (token === epoch) void endSession('对方已断开，等待下次连接'); };
  channel.onmessage = event => {
    if (token !== epoch || role !== 'host' || typeof event.data !== 'string' || event.data.length > 16384) return;
    if (Date.now() - controlWindow > 1000) { controlWindow = Date.now(); controlCount = 0; }
    if (++controlCount > 500) { void stopAll('输入频率异常，已停止共享'); return; }
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'quality') { void action(() => applyQuality(message.value)); return; }
      api.input(message);
    } catch { /* 忽略无效数据，不影响当前视频。 */ }
  };
}

async function createPeer(message) {
  clearPeer();
  role = message.role; sessionId = message.session;
  const token = epoch;
  const peer = new RTCPeerConnection({ iceServers: message.ice, bundlePolicy: 'max-bundle' });
  pc = peer;
  peer.onicecandidate = event => { if (event.candidate && token === epoch) void action(() => api.signal({ type: 'candidate', candidate: event.candidate.toJSON() })); };
  peer.onconnectionstatechange = () => {
    if (token !== epoch) return;
    if (peer.connectionState === 'connected') {
      clearTimeout(connectionTimer); clearTimeout(disconnectedTimer);
      status(role === 'host' ? '共享中 · 对方可控制' : '已连接 · 加密传输', true);
      notice(role === 'host' ? '随时点击停止共享，或按 Ctrl + Alt + F12。' : '点击远程画面后，鼠标和键盘将发送到对方电脑。');
    } else if (peer.connectionState === 'failed') void endSession('视频连接失败。跨网络连接请配置可用的 TURN 中继。');
    else if (peer.connectionState === 'disconnected') {
      status('网络中断，等待恢复…');
      if (role === 'host') api.input({ type: 'release' });
      clearTimeout(disconnectedTimer);
      disconnectedTimer = setTimeout(() => { if (token === epoch) void endSession('网络未恢复，请重新连接'); }, 12000);
    }
  };
  connectionTimer = setTimeout(() => { if (token === epoch) void endSession('建立视频连接超时。请检查防火墙和 TURN 配置。'); }, 30000);
  if (role === 'host') {
    $('setup').hidden = true;
    $('host-active').hidden = false;
    status('已允许，正在共享…', true);
    attachChannel(peer.createDataChannel('control', { ordered: true }), token);
    for (const display of message.screens) {
      const id = await api.capture(display.id);
      if (token !== epoch) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: id,
        maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60
      } } });
      if (token !== epoch) { stream.getTracks().forEach(track => track.stop()); return; }
      captureStreams.push(stream);
      const track = stream.getVideoTracks()[0];
      track.onended = () => { if (token === epoch) void stopAll('屏幕采集已停止，请重新开启共享'); };
      peer.addTrack(track, stream);
    }
    // 浏览器负责硬件加速与编解码协商，不强制不受设备支持的编码器。
    await peer.setLocalDescription(await peer.createOffer());
    if (token !== epoch) return;
    const screens = message.screens.map((display, index) => ({ id: display.id, name: `屏幕 ${index + 1}`, width: display.width, height: display.height,
      mid: peer.getTransceivers()[index].mid }));
    await api.signal({ type: 'offer', sdp: peer.localDescription.sdp, screens });
    await applyQuality(quality);
  } else {
    $('setup').hidden = true; $('session').hidden = false;
    document.body.classList.add('session-mode');
    status('正在建立视频连接…');
    peer.ondatachannel = event => { if (token === epoch) attachChannel(event.channel, token); };
    peer.ontrack = event => {
      if (token !== epoch) return;
      const display = remoteScreens.find(screen => screen.mid === event.transceiver.mid);
      if (display) addVideo(display, new MediaStream([event.track]));
    };
    startStats(peer, token);
  }
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
    remoteScreens = data.screens;
    $('layout').replaceChildren(new Option('双屏并排', 'all'), ...remoteScreens.map(display => new Option(display.name, display.id)));
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
function addVideo(display, stream) {
  const surface = document.createElement('div'); surface.className = 'remote-screen'; surface.tabIndex = 0;
  surface.dataset.screen = display.id; surface.setAttribute('aria-label', `${display.name}，点击后可远程控制`);
  const label = document.createElement('div'); label.className = 'screen-label'; label.textContent = display.name;
  const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true; video.srcObject = stream;
  surface.append(label, video); $('videos').append(surface);
  void video.play().catch(showError);
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
    if (!allowControl || document.activeElement !== surface || performance.now() - lastMove < 16) return;
    const position = point(event); if (!position || !position.inside && !video.hasPointerCapture(event.pointerId)) return;
    lastMove = performance.now(); sendData({ type: 'move', screen: display.id, ...position });
  });
  video.addEventListener('wheel', event => {
    if (!allowControl || document.activeElement !== surface) return;
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
}
function updateLayout() {
  release();
  const value = $('layout').value;
  for (const surface of $('videos').children) surface.hidden = value !== 'all' && surface.dataset.screen !== value;
  $('videos').classList.toggle('single', value !== 'all' || remoteScreens.length === 1);
}

function startStats(peer, token) {
  let collecting = false;
  statsTimer = setInterval(async () => {
    if (collecting || token !== epoch) return;
    collecting = true;
    try {
      const reports = await peer.getStats();
      if (token !== epoch) return;
      const videos = []; let rtt = null, route = '';
      reports.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const previous = lastStats.get(report.id);
          const elapsed = previous ? (report.timestamp - previous.time) / 1000 : 0;
          const bitrate = elapsed > 0 ? (report.bytesReceived - previous.bytes) * 8 / elapsed / 1e6 : 0;
          const fps = elapsed > 0 ? (report.framesDecoded - previous.frames) / elapsed : 0;
          lastStats.set(report.id, { time: report.timestamp, bytes: report.bytesReceived, frames: report.framesDecoded || 0 });
          const codec = reports.get(report.codecId)?.mimeType?.replace('video/', '') || '';
          videos.push(`${report.frameWidth || '—'}×${report.frameHeight || '—'} ${Math.round(fps)}fps ${bitrate.toFixed(1)}Mbps ${codec}`);
        }
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          const pair = reports.get(report.selectedCandidatePairId);
          if (pair?.currentRoundTripTime !== undefined) rtt = Math.round(pair.currentRoundTripTime * 1000);
          route = [reports.get(pair?.localCandidateId), reports.get(pair?.remoteCandidateId)].some(candidate => candidate?.candidateType === 'relay') ? '中继' : '直连';
        }
      });
      $('stats').textContent = videos.length ? videos.join(' / ') : '等待视频数据…';
      $('session-detail').textContent = `${remoteScreens.length} 个屏幕 · ${route || '协商中'} · RTT ${rtt === null ? '—' : rtt + ' ms'}`;
    } catch { /* 连接关闭时忽略最后一次统计。 */ }
    finally { collecting = false; }
  }, 1000);
}

async function onEvent(message) {
  switch (message.type) {
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
$('layout').addEventListener('change', updateLayout);
$('quality').addEventListener('change', () => { sendData({ type: 'quality', value: $('quality').value }); notice('画质上限已调整，实际帧率与分辨率随网络和画面变化。'); });
$('control-toggle').addEventListener('click', () => {
  release(); allowControl = !allowControl;
  $('control-toggle').textContent = allowControl ? '控制已开启' : '仅观看';
  $('control-toggle').setAttribute('aria-pressed', String(allowControl));
});
$('fullscreen').addEventListener('click', () => void action(async () => {
  fullScreen = !fullScreen; await api.fullscreen(fullScreen); $('fullscreen').textContent = fullScreen ? '退出全屏' : '全屏';
}));
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
  canAutoStart = settings.canAutoStart; preferredDisplays = settings.displayIds;
  $('server').value = settings.url || localStorage.getItem('ydesk-server') || 'ws://127.0.0.1:21120';
  $('ice').value = settings.ice.length ? JSON.stringify(settings.ice, null, 2) : '';
  $('unattended').checked = settings.unattended;
  $('auto-start').checked = canAutoStart && settings.autoStart;
  $('auto-start').disabled = !canAutoStart || !settings.unattended;
  if (!canAutoStart) $('auto-start-hint').textContent = '登录自启请使用安装版；当前版本仍可在系统托盘保持无人值守。';
  if (settings.passwordSaved) $('host-password').placeholder = '已保存密码；留空沿用，输入可修改';
  await refreshScreens();
  if (settings.autoShare) { role = 'host'; unattended = true; sharing = true; setBusy(true); await api.resume(); }
});

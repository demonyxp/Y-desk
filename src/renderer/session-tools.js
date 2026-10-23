'use strict';
class SessionTools {
  constructor({ api, sendControl, session, notice, action }) {
    Object.assign(this, { api, sendControl, session, notice, action });
    this.token = 0; this.prefs = {}; this.samples = []; this.peerSamples = [];
  }
  $(id) { return document.getElementById(id); }
  async init() {
    this.prefs = await this.api.tools('preferences'); this.preferences();
    this.$('clipboard-enable').addEventListener('change', () => void this.action(async () => {
      this.prefs = await this.api.tools('preferences-save', { clipboard: this.$('clipboard-enable').checked });
      this.lastClipboard = undefined; this.features(); this.preferences();
    }));
    this.$('auto-receive').addEventListener('change', () => void this.action(async () => {
      this.prefs = await this.api.tools('preferences-save', { autoReceive: this.$('auto-receive').checked }); this.preferences();
    }));
    this.$('receive-folder').addEventListener('click', () => void this.action(async () => { this.prefs = await this.api.tools('folder'); this.preferences(); }));
    this.$('send-file').addEventListener('click', () => void this.action(() => this.pick()));
    this.$('cancel-file').addEventListener('click', () => void this.cancelAll());
    this.$('tools-toggle').addEventListener('click', () => { this.$('session-tools').hidden = !this.$('session-tools').hidden; });
    this.$('tools-close').addEventListener('click', () => { this.$('session-tools').hidden = true; });
    this.$('host-tools').addEventListener('click', () => { this.$('session-tools').hidden = false; });
    this.$('settings-tools').addEventListener('click', () => { this.$('session-tools').hidden = false; });
    this.$('export-diagnostics').addEventListener('click', () => void this.action(async () => {
      await this.api.tools('diagnostics', { samples: this.samples, peerSamples: this.peerSamples }); this.notice('诊断已导出，未包含密码、设备码或 IP 地址。');
    }));
    this.$('test-network').addEventListener('click', () => void this.action(() => this.testNetwork()));
    await this.devices();
  }
  preferences() {
    this.$('clipboard-enable').checked = Boolean(this.prefs.clipboard);
    this.$('auto-receive').checked = Boolean(this.prefs.autoReceive);
    this.$('auto-receive').disabled = !this.prefs.folder;
    this.$('receive-path').textContent = this.prefs.folder || '尚未选择接收目录';
  }
  async devices() {
    const devices = await this.api.tools('devices');
    const list = this.$('device-list'); list.replaceChildren();
    if (!devices.length) { list.textContent = '成功连接的设备会显示在这里，密码不会保存。'; return; }
    devices.sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.lastConnected - a.lastConnected);
    for (const device of devices) {
      const row = document.createElement('div'); row.className = 'device-row';
      const name = document.createElement('input'); name.value = device.name || ''; name.placeholder = device.id; name.maxLength = 60; name.setAttribute('aria-label', `${device.id} 设备备注`);
      name.addEventListener('change', () => void this.action(() => this.api.tools('device-edit', { id: device.id, url: device.url, name: name.value })));
      const connect = document.createElement('button'); connect.className = 'secondary'; connect.textContent = device.id; connect.title = device.url;
      connect.addEventListener('click', () => {
        if (this.$('remote-id').disabled) return;
        this.$('remote-id').value = device.id; this.$('server').value = device.url; this.$('remote-password').value = ''; this.$('remote-password').focus();
      });
      const favorite = document.createElement('button'); favorite.textContent = device.favorite ? '已收藏' : '收藏'; favorite.className = 'text-button'; favorite.setAttribute('aria-label', device.favorite ? '取消收藏' : '收藏设备');
      favorite.addEventListener('click', () => void this.action(async () => { await this.api.tools('device-edit', { id: device.id, url: device.url, favorite: !device.favorite }); await this.devices(); }));
      const remove = document.createElement('button'); remove.textContent = '移除'; remove.className = 'text-button';
      remove.addEventListener('click', () => void this.action(async () => { await this.api.tools('device-edit', { id: device.id, url: device.url, remove: true }); await this.devices(); }));
      row.append(name, connect, favorite, remove); list.append(row);
    }
  }
  features() { this.sendControl({ type: 'features', version: 1, clipboard: Boolean(this.prefs.clipboard), files: true }); }
  start(role, peer) {
    this.role = role; this.peer = peer; this.features();
    this.$('tools-toggle').disabled = false; this.$('host-tools').disabled = false;
    this.$('export-diagnostics').disabled = false;
    this.$('tools-status').textContent = '正在检测对端功能…';
    this.clipTimer = setInterval(() => void this.pollClipboard(), 500);
    this.capTimer = setTimeout(() => {
      if (this.remote) return;
      this.$('tools-status').textContent = '对端版本不支持文件与剪贴板，请两端升级至 v0.5.0。';
      if (this.role === 'viewer') this.$('quality').querySelector('[value="auto"]').disabled = true;
      if (this.role === 'viewer' && this.$('quality').value === 'auto') {
        this.$('quality').value = 'smooth'; this.sendControl({ type: 'quality', value: 'smooth' });
      }
    }, 3000);
    if (role === 'viewer') void this.devices();
  }
  control(message) {
    if (message.type === 'features' && message.version === 1) {
      this.$('quality').querySelector('[value="auto"]').disabled = false;
      this.remote = true; this.remoteClipboard = message.clipboard === true;
      this.$('tools-status').textContent = this.remoteClipboard && this.prefs.clipboard ? '双向文本同步已开启' : '文本同步需要两端同时开启';
      if (this.role === 'host' && !this.fileChannel) {
        this.attach(this.peer.createDataChannel('files', { ordered: true }));
        this.attach(this.peer.createDataChannel('clipboard', { ordered: true }));
      }
      return true;
    }
    if (message.type === 'telemetry') {
      // 仅复制已知数值字段，不将远端文本或标识写入诊断文件。
      this.peerSamples = Array.isArray(message.videos) ? message.videos.slice(0, 2).map(video => ({
        width: Number(video.width) || null, height: Number(video.height) || null, fps: Number(video.fps) || null,
        encodeMs: Number(video.encodeMs) || null, limitation: ['cpu', 'bandwidth', 'none', 'other'].includes(video.limitation) ? video.limitation : '不可用' })) : [];
      const labels = { cpu: '处理器', bandwidth: '带宽', none: '无', other: '其他' };
      this.$('performance-detail').textContent = this.peerSamples.map((item, i) => `屏幕 ${i + 1}：编码 ${item.encodeMs ?? '—'} ms · 限制 ${labels[item.limitation] || '不可用'}`).join(' / ');
      return true;
    }
    return false;
  }
  stats(sample) {
    this.samples.push(sample); if (this.samples.length > 60) this.samples.shift();
    // 纯接收视频端的出站 RTP 估计不能代表文件上传能力。
    this.bandwidth = sample.role === 'host' ? sample.bandwidth : null;
    if (this.role === 'host' && this.remote) this.sendControl({ type: 'telemetry', videos: sample.videos });
  }
  attach(channel) {
    if (!['files', 'clipboard'].includes(channel.label)) return false;
    const key = channel.label === 'files' ? 'fileChannel' : 'clipChannel';
    if (this[key]) { channel.close(); return true; }
    this[key] = channel; const token = this.token;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => { if (token === this.token && key === 'fileChannel') this.$('send-file').disabled = false; };
    channel.onclose = () => { if (token === this.token) { if (key === 'fileChannel') { this.$('send-file').disabled = true; void this.cancelAll(); } } };
    let queue = Promise.resolve(), queuedBytes = 0;
    channel.onmessage = event => {
      const size = typeof event.data === 'string' ? event.data.length * 2 : event.data.byteLength;
      if (size > (key === 'clipChannel' ? 131072 : 16384) || queuedBytes + size > 524288) {
        channel.close(); this.notice('传输消息超限，已关闭数据通道', true); return;
      }
      queuedBytes += size;
      queue = queue.then(async () => {
        if (token !== this.token) return;
        if (key === 'clipChannel') {
          if (!this.prefs.clipboard || !this.remoteClipboard || typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > 65536) return;
          this.clipRevision = (this.clipRevision || 0) + 1; this.clipWriting = true;
          try { this.lastClipboard = event.data; await this.api.tools('clipboard-write', { text: event.data }); }
          finally { this.clipWriting = false; }
        } else await this.receive(event.data, token);
      }).catch(error => { if (token === this.token) { this.notice(`传输失败：${error.message}`, true); void this.cancelAll(); } }).finally(() => { queuedBytes -= size; });
    };
    return true;
  }
  async pollClipboard() {
    if (this.polling || this.clipWriting || !this.prefs.clipboard || !this.remoteClipboard || this.clipChannel?.readyState !== 'open') return;
    this.polling = true; const token = this.token, revision = this.clipRevision;
    try {
      const text = await this.api.tools('clipboard-read');
      if (token !== this.token || this.clipWriting || revision !== this.clipRevision || !this.prefs.clipboard || !this.remoteClipboard || this.clipChannel?.readyState !== 'open' || text === null) return;
      if (this.lastClipboard !== undefined && text !== this.lastClipboard && this.clipChannel.bufferedAmount < 65536) this.clipChannel.send(text);
      this.lastClipboard = text;
    } catch { /* 断开时停止本次轮询。 */ }
    finally { this.polling = false; }
  }
  send(message) { if (this.fileChannel?.readyState === 'open') this.fileChannel.send(JSON.stringify(message)); }
  progress() {
    this.$('transfer-progress').textContent = [this.out && `发送 ${this.out.name} · ${Math.floor(this.out.offset / Math.max(1, this.out.size) * 100)}%`, this.in && `接收 ${this.in.name} · ${Math.floor(this.in.offset / Math.max(1, this.in.size) * 100)}%`, this.pending && `等待接收 ${this.pending.name}`].filter(Boolean).join(' / ') || '没有进行中的传输';
    this.$('cancel-file').disabled = !this.out && !this.in && !this.pending;
  }
  async pick() {
    if (!this.remote || this.fileChannel?.readyState !== 'open') throw new Error('对方版本不支持文件传输');
    if (this.out) throw new Error('请等待当前文件发送完成');
    const token = this.token, file = await this.api.tools('file-pick');
    if (!file || token !== this.token) return;
    this.out = { ...file, offset: 0, ack: 0, lastAck: Date.now() }; this.send({ type: 'offer', ...file }); this.progress();
  }
  async pump(job, token) {
    try {
      while (token === this.token && this.out === job && job.offset < job.size) {
        if (this.fileChannel?.readyState !== 'open') throw new Error('数据通道已关闭');
        if (job.offset - job.ack >= 262144 || this.fileChannel.bufferedAmount >= 65536) {
          if (Date.now() - job.lastAck > 20000) throw new Error('文件传输超时');
          await new Promise(resolve => setTimeout(resolve, 25)); continue;
        }
        const bytes = await this.api.tools('file-read', { id: job.id });
        if (token !== this.token || this.out !== job) return;
        this.fileChannel.send(bytes); job.offset += bytes.length; this.progress();
        // 持续限速并保留控制流量；共享 SCTP 连接不能只依赖独立通道隔离。
        const rate = Math.max(16384, Math.min(524288, this.bandwidth ? this.bandwidth * 0.2 / 8 : 131072));
        await new Promise(resolve => setTimeout(resolve, bytes.length / rate * 1000));
      }
      if (token === this.token && this.out === job) {
        this.send({ type: 'done', id: job.id });
        job.timer = setTimeout(() => { if (this.out === job) { this.notice('等待接收完成超时', true); void this.cancelAll(); } }, 30000);
      }
    } catch (error) { if (token === this.token && this.out === job) { this.notice(`发送失败：${error.message}`, true); await this.cancelAll(); } }
  }
  async receive(data, token) {
    if (data instanceof ArrayBuffer) {
      const job = this.in;
      if (!job || data.byteLength > 16384 || !data.byteLength) throw new Error('无效文件数据');
      job.offset = await this.api.tools('file-write', { id: job.id, bytes: new Uint8Array(data) });
      if (token !== this.token || this.in !== job) return;
      this.send({ type: 'ack', id: job.id, offset: job.offset }); this.progress(); return;
    }
    if (typeof data !== 'string' || data.length > 2048) throw new Error('文件消息过大');
    const message = JSON.parse(data);
    if (message.type === 'offer') {
      if (this.in || this.pending) { this.send({ type: 'reject', id: message.id }); return; }
      this.pending = message; this.progress();
      let accepted = false;
      try { accepted = await this.api.tools('file-accept', message); }
      catch (error) { this.notice(error.message, true); }
      if (token !== this.token) return;
      if (this.pending !== message) { if (accepted) await this.api.tools('file-cancel', { id: message.id }); return; }
      this.pending = null;
      if (accepted) this.in = { ...message, offset: 0 };
      this.send({ type: accepted ? 'accept' : 'reject', id: message.id }); this.progress();
    } else if (message.type === 'accept' && this.out?.id === message.id && !this.out.started) {
      this.out.started = true; void this.pump(this.out, token);
    } else if (message.type === 'ack' && this.out?.id === message.id) {
      if (Number.isSafeInteger(message.offset) && message.offset >= this.out.ack && message.offset <= this.out.offset) { this.out.ack = message.offset; this.out.lastAck = Date.now(); }
    } else if (message.type === 'done' && this.in?.id === message.id) {
      const job = this.in; await this.api.tools('file-finish', { id: job.id });
      if (token !== this.token || this.in !== job) return;
      this.send({ type: 'complete', id: job.id }); this.in = null; this.progress(); this.notice('文件接收完成。');
    } else if (['complete', 'reject', 'cancel'].includes(message.type)) {
      for (const key of ['out', 'in', 'pending']) if (this[key]?.id === message.id) {
        clearTimeout(this[key].timer); this[key] = null; await this.api.tools('file-cancel', { id: message.id });
      }
      this.progress(); this.notice(message.type === 'complete' ? '文件发送完成。' : '文件传输已取消或被拒绝。');
    }
  }
  async cancelAll() {
    const jobs = [this.out, this.in, this.pending].filter(Boolean); this.out = this.in = this.pending = null;
    this.progress();
    for (const job of jobs) { clearTimeout(job.timer); this.send({ type: 'cancel', id: job.id }); await this.api.tools('file-cancel', { id: job.id }).catch(() => {}); }
  }
  clear() {
    this.token++; clearInterval(this.clipTimer); clearTimeout(this.capTimer); clearTimeout(this.out?.timer);
    this.out = this.in = this.pending = null; this.remote = this.remoteClipboard = false; this.lastClipboard = undefined;
    this.peer = this.fileChannel = this.clipChannel = null; this.samples = []; this.peerSamples = [];
    this.$('quality').querySelector('[value="auto"]').disabled = false;
    for (const id of ['tools-toggle', 'host-tools', 'send-file', 'export-diagnostics']) this.$(id).disabled = true;
    this.$('session-tools').hidden = true; this.progress();
  }
  async testNetwork() {
    const button = this.$('test-network'), output = this.$('network-result'); button.disabled = true; output.textContent = '检测信令及中继…';
    let peer;
    try {
      const server = this.$('server').value.trim();
      const ice = this.$('advanced-network').checked ? JSON.parse(this.$('ice').value || '[]') : await this.api.relay({ server, address: this.$('relay-address').value, username: this.$('relay-user').value, password: this.$('relay-password').value });
      const ok = await this.api.testServer(server);
      if (!ok) { output.textContent = '信令连接失败，请检查域名、证书和 Nginx。'; return; }
      if (!ice.some(item => [].concat(item.urls).some(url => /^turns?:/.test(url)))) { output.textContent = '信令可连接；未配置中继，跨网络连接可能失败。'; return; }
      peer = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: 'relay' }); peer.createDataChannel('probe');
      const relay = await new Promise((resolve, reject) => {
        let done = false; const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
        const timer = setTimeout(() => finish(false), 8000);
        peer.onicecandidate = event => { if (event.candidate?.type === 'relay') finish(true); else if (!event.candidate) finish(false); };
        peer.createOffer().then(offer => peer.setLocalDescription(offer)).catch(error => { clearTimeout(timer); reject(error); });
      });
      output.textContent = relay ? '信令和 TURN 分配正常；实际连通性仍需连接对端验证。' : '信令正常，TURN 未能分配地址；检查账号密码、3478 端口与服务状态。';
    } finally { peer?.close(); button.disabled = false; }
  }
}

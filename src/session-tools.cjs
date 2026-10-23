'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { basename, dirname, join, extname } = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_FILE = 2 * 1024 ** 3;
function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 180 || name !== basename(name) || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) || name === '..') throw new Error('文件名无效');
  return name;
}
function createSessionTools({ dialog, clipboard, window, session, profile, save, downloads }) {
  const outgoing = new Map(), incoming = new Map();
  let generation = 0, picking = false, receiving = false;
  const prefs = () => ({ clipboard: Boolean(profile().tools?.clipboard), autoReceive: Boolean(profile().tools?.autoReceive), folder: profile().tools?.folder || '' });
  const requireSession = () => { const id = session(); if (!id) throw new Error('请先建立已授权的远程连接'); return id; };
  const valid = (id, gen) => { if (session() !== id || generation !== gen) throw new Error('连接已结束'); };
  async function dispose(job) {
    if (!job) return;
    job.cancelled = true;
    await job.file?.close().catch(() => {});
    if (job.temp) await fs.unlink(job.temp).catch(() => {});
  }
  async function clear() {
    generation++;
    const jobs = [...outgoing.values(), ...incoming.values()]; outgoing.clear(); incoming.clear();
    await Promise.all(jobs.map(dispose));
  }
  async function unique(file) {
    const ext = extname(file), stem = basename(file, ext);
    for (let n = 0; n < 10000; n++) {
      const next = n ? join(dirname(file), `${stem} (${n})${ext}`) : file;
      try { await fs.access(next); } catch (error) { if (error.code === 'ENOENT') return next; throw error; }
    }
    throw new Error('同名文件过多，请选择其他目录');
  }
  async function call(op, args = {}) {
    if (op === 'preferences') return prefs();
    if (op === 'preferences-save') {
      const next = prefs();
      if (typeof args.clipboard === 'boolean') next.clipboard = args.clipboard;
      if (typeof args.autoReceive === 'boolean') next.autoReceive = args.autoReceive && Boolean(next.folder);
      save({ ...profile(), tools: next }); return next;
    }
    if (op === 'folder') {
      const result = await dialog.showOpenDialog(window(), { title: '选择无人值守接收目录', properties: ['openDirectory', 'createDirectory'], defaultPath: prefs().folder || downloads() });
      if (!result.canceled) save({ ...profile(), tools: { ...prefs(), folder: result.filePaths[0] } });
      return prefs();
    }
    if (op === 'devices') return profile().devices || [];
    if (op === 'device-edit') {
      const devices = (profile().devices || []).map(device => device.id === args.id && device.url === args.url ? { ...device,
        name: typeof args.name === 'string' ? args.name.trim().slice(0, 60) : device.name,
        favorite: typeof args.favorite === 'boolean' ? args.favorite : device.favorite } : device).filter(device => !(args.remove && device.id === args.id && device.url === args.url));
      save({ ...profile(), devices }); return devices;
    }
    const sid = requireSession(), gen = generation;
    if (op === 'diagnostics') {
      const text = JSON.stringify({ version: 1, samples: args.samples, peerSamples: args.peerSamples }, null, 2);
      if (text.length > 131072) throw new Error('诊断数据过大');
      const result = await dialog.showSaveDialog(window(), { title: '保存连接诊断', defaultPath: join(downloads(), 'Y-Desk-diagnostics.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
      valid(sid, gen); if (!result.canceled) await fs.writeFile(result.filePath, text, 'utf8'); return !result.canceled;
    }
    if (op === 'clipboard-read') {
      if (!prefs().clipboard) return null;
      const text = clipboard.readText(); return Buffer.byteLength(text, 'utf8') <= 65536 ? text : null;
    }
    if (op === 'clipboard-write') {
      if (!prefs().clipboard || typeof args.text !== 'string' || Buffer.byteLength(args.text, 'utf8') > 65536) return false;
      clipboard.writeText(args.text); return true;
    }
    if (op === 'file-pick') {
      if (outgoing.size || picking) throw new Error('请等待当前文件发送完成');
      picking = true;
      try {
        const result = await dialog.showOpenDialog(window(), { title: '发送文件（最大 2 GB）', properties: ['openFile'] });
        valid(sid, gen); if (result.canceled) return null;
        const path = result.filePaths[0], name = safeName(basename(path));
        const file = await fs.open(path, 'r');
        try {
          const info = await file.stat(); valid(sid, gen);
          if (!info.isFile() || info.size > MAX_FILE) throw new Error('请选择不超过 2 GB 的普通文件');
          const id = randomUUID(); outgoing.set(id, { file, size: info.size, offset: 0 });
          return { id, name, size: info.size };
        } catch (error) { await file.close(); throw error; }
      } finally { picking = false; }
    }
    if (op === 'file-accept') {
      const name = safeName(args.name);
      if (!/^[a-f0-9-]{36}$/.test(args.id) || !Number.isSafeInteger(args.size) || args.size < 0 || args.size > MAX_FILE) throw new Error('文件信息无效');
      if (incoming.size || receiving) throw new Error('已有接收中的文件');
      receiving = true;
      let job;
      try {
        let path;
        if (prefs().autoReceive && prefs().folder) path = join(prefs().folder, name);
        else {
          const result = await dialog.showSaveDialog(window(), { title: `接收文件：${name}`, defaultPath: join(prefs().folder || downloads(), name) });
          valid(sid, gen); if (result.canceled) return false;
          path = result.filePath;
        }
        valid(sid, gen); path = await unique(path); valid(sid, gen);
        const temp = join(dirname(path), `.ydesk-${randomUUID()}.part`);
        const file = await fs.open(temp, 'wx');
        job = { file, temp, path, size: args.size, offset: 0 }; valid(sid, gen);
        incoming.set(args.id, job); return true;
      } catch (error) { await dispose(job); throw error; }
      finally { receiving = false; }
    }
    if (op === 'file-read') {
      const job = outgoing.get(args.id);
      if (!job || job.cancelled || job.reading) throw new Error('发送任务无效');
      job.reading = true;
      try {
        const buffer = Buffer.alloc(Math.min(16384, job.size - job.offset));
        const { bytesRead } = await job.file.read(buffer, 0, buffer.length, job.offset); valid(sid, gen);
        if (job.cancelled || bytesRead === 0 && job.offset < job.size) throw new Error('文件已变化或发送已取消');
        job.offset += bytesRead; return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally { job.reading = false; }
    }
    if (op === 'file-write') {
      const job = incoming.get(args.id), bytes = args.bytes;
      if (!job || job.cancelled || job.writing || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16384 || job.offset + bytes.length > job.size) throw new Error('文件分块无效');
      job.writing = true;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const result = await job.file.write(bytes, offset, bytes.length - offset, job.offset + offset);
          valid(sid, gen); if (job.cancelled || !result.bytesWritten) throw new Error('接收已取消或磁盘不可写');
          offset += result.bytesWritten;
        }
        job.offset += bytes.length; return job.offset;
      } finally { job.writing = false; }
    }
    if (op === 'file-finish') {
      const job = incoming.get(args.id);
      if (!job || job.offset !== job.size || job.writing) throw new Error('文件尚未接收完整');
      try {
        await job.file.sync(); await job.file.close(); job.file = null; valid(sid, gen);
        if (job.cancelled) throw new Error('接收已取消');
        // 排他复制保证外部程序刚创建的同名文件也不会被覆盖。
        await fs.copyFile(job.temp, job.path, constants.COPYFILE_EXCL);
        incoming.delete(args.id); await dispose(job); return true;
      } catch (error) { incoming.delete(args.id); await dispose(job); throw error; }
    }
    if (op === 'file-cancel') {
      const jobs = [outgoing.get(args.id), incoming.get(args.id)]; outgoing.delete(args.id); incoming.delete(args.id);
      await Promise.all(jobs.map(dispose)); return true;
    }
    throw new Error('不支持的会话操作');
  }
  function record(id, url) {
    const old = (profile().devices || []).find(item => item.id === id && item.url === url);
    const devices = [{ ...old, id, url, lastConnected: Date.now() }, ...(profile().devices || []).filter(item => item !== old)];
    const favorites = devices.filter(item => item.favorite);
    save({ ...profile(), devices: [...favorites, ...devices.filter(item => !item.favorite).slice(0, Math.max(0, 20 - favorites.length))].slice(0, 20) });
  }
  return { call, clear, record };
}
module.exports = { createSessionTools, safeName };

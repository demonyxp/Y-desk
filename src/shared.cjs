'use strict';

const QUALITY = Object.freeze({
  economy: { label: '低带宽', width: 1280, height: 720, fps: 30, bitrate: 1_500_000, hint: 'motion' },
  smooth: { label: '流畅', width: 1920, height: 1080, fps: 30, bitrate: 4_000_000, hint: 'motion' },
  balanced: { label: '高清', width: 2560, height: 1440, fps: 60, bitrate: 12_000_000, hint: 'detail' },
  ultra: { label: '原画', width: 3840, height: 2160, fps: 60, bitrate: 25_000_000, hint: 'detail' }
});

function relayServers({ server, address, username, password }) {
  if (!username && !password) return [];
  if (!username?.trim() || !password) throw new Error('请填写中继账号和密码，或同时留空使用直连');
  const host = address?.trim() || new URL(serverUrl(server)).hostname;
  if (!/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(host)) throw new Error('中继地址请填写域名或 IP，可附端口，例如 desk.example.com:3478');
  const match = host.match(/:(\d+)$/);
  if (match && (+match[1] < 1 || +match[1] > 65535)) throw new Error('中继端口应为 1–65535');
  const endpoint = match ? host : `${host}:3478`;
  return iceServers([{ urls: `stun:${endpoint}` }, { urls: [`turn:${endpoint}?transport=udp`, `turn:${endpoint}?transport=tcp`], username: username.trim(), credential: password }]);
}

function serverUrl(value) {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('服务器地址必须是 ws:// 或 wss://，不能含密码或查询参数');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !local) throw new Error('远程服务器必须使用 wss:// 加密连接');
  return url.href;
}

function iceServers(value) {
  const list = typeof value === 'string' ? JSON.parse(value || '[]') : value;
  if (!Array.isArray(list) || list.length > 8) throw new Error('ICE 配置应为最多 8 项的 JSON 数组');
  return list.map(item => {
    if (!item || typeof item !== 'object') throw new Error('ICE 配置格式错误');
    const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
    if (!urls.length || urls.length > 8 || urls.some(url => typeof url !== 'string' || !/^(stun|stuns|turn|turns):[^\s]{1,500}$/.test(url))) {
      throw new Error('ICE 地址必须使用 stun:、stuns:、turn: 或 turns:');
    }
    const result = { urls };
    for (const key of ['username', 'credential']) {
      if (item[key] !== undefined) {
        if (typeof item[key] !== 'string' || item[key].length > 512) throw new Error('TURN 凭据格式错误');
        result[key] = item[key];
      }
    }
    return result;
  });
}

const fixedKeys = {
  Escape: 0x1b, Tab: 9, Backspace: 8, Enter: 13, Space: 32,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3,
  AltLeft: 0xa4, AltRight: 0xa5, MetaLeft: 0x5b, MetaRight: 0x5c,
  CapsLock: 20, NumLock: 144, ScrollLock: 145, Pause: 19,
  Insert: 45, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190,
  Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220,
  BracketRight: 221, Quote: 222, ContextMenu: 93,
  NumpadAdd: 107, NumpadSubtract: 109, NumpadMultiply: 106,
  NumpadDivide: 111, NumpadDecimal: 110, NumpadEnter: 13
};
const extended = new Set(['ControlRight', 'AltRight', 'MetaLeft', 'MetaRight', 'Insert', 'Delete',
  'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'NumpadDivide', 'NumpadEnter', 'NumLock', 'ContextMenu']);

function keyCode(code) {
  if (typeof code !== 'string') return null;
  let vk = Object.hasOwn(fixedKeys, code) ? fixedKeys[code] : null;
  if (/^Key[A-Z]$/.test(code)) vk = code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) vk = code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) vk = 96 + Number(code.at(-1));
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) vk = 111 + Number(code.slice(1));
  return vk ? { vk, extended: extended.has(code) } : null;
}

function normalizeInput(message, displays, toPhysical = point => point) {
  if (!message || typeof message !== 'object') return null;
  if (message.type === 'release' || message.type === 'heartbeat') return { type: message.type };
  if (message.type === 'key') {
    const key = keyCode(message.code);
    return key && typeof message.down === 'boolean' ? { type: 'key', ...key, down: message.down } : null;
  }
  if (message.type === 'text') {
    return typeof message.text === 'string' && message.text.length <= 2000
      ? { type: 'text', text: message.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') } : null;
  }
  if (!['move', 'button', 'wheel'].includes(message.type)) return null;
  const display = displays.find(item => item.id === message.screen);
  if (!display || !Number.isFinite(message.x) || !Number.isFinite(message.y) ||
      message.x < 0 || message.x > 1 || message.y < 0 || message.y > 1) return null;
  const { bounds } = display;
  const point = toPhysical({
    x: bounds.x + Math.round(message.x * (bounds.width - 1)),
    y: bounds.y + Math.round(message.y * (bounds.height - 1))
  });
  const result = { type: message.type, x: point.x, y: point.y };
  if (message.type === 'button') {
    if (![0, 1, 2].includes(message.button) || typeof message.down !== 'boolean') return null;
    Object.assign(result, { button: message.button, down: message.down });
  }
  if (message.type === 'wheel') {
    if (!Number.isFinite(message.delta)) return null;
    result.delta = Math.max(-1200, Math.min(1200, Math.round(message.delta)));
  }
  return result;
}

module.exports = { QUALITY, serverUrl, iceServers, relayServers, normalizeInput, keyCode };

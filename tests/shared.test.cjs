const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverUrl, iceServers, normalizeInput, keyCode } = require('../src/shared.cjs');

test('公网只接受 TLS 信令，拒绝 URL 中携带凭据', () => {
  assert.equal(serverUrl('ws://127.0.0.1:21120'), 'ws://127.0.0.1:21120/');
  assert.equal(serverUrl('wss://desk.example.com'), 'wss://desk.example.com/');
  for (const value of ['ws://192.168.1.2', 'https://desk.example.com', 'wss://u:p@example.com', 'wss://example.com/?token=abc']) {
    assert.throws(() => serverUrl(value));
  }
});
test('校验 TURN 地址并仅传递已知配置', () => {
  assert.deepEqual(iceServers('[{"urls":"turn:example.com:3478","username":"u","credential":"p","other":1}]'),
    [{ urls: ['turn:example.com:3478'], username: 'u', credential: 'p' }]);
  for (const value of ['{}', '[null]', '[{"urls":"https://example.com"}]']) assert.throws(() => iceServers(value));
});
test('左侧负坐标显示器与 DPI 转换使用目标屏幕边界', () => {
  const displays = [{ id: 'left', bounds: { x: -1920, y: -200, width: 1920, height: 1080 } }];
  assert.deepEqual(normalizeInput({ type: 'move', screen: 'left', x: 0, y: 1 }, displays), { type: 'move', x: -1920, y: 879 });
  assert.deepEqual(normalizeInput({ type: 'move', screen: 'left', x: 1, y: 0 }, displays, p => ({ x: p.x * 2, y: p.y * 2 })),
    { type: 'move', x: -2, y: -400 });
  assert.equal(normalizeInput({ type: 'move', screen: 'other', x: 0, y: 0 }, displays), null);
  assert.equal(normalizeInput({ type: 'move', screen: 'left', x: NaN, y: 0 }, displays), null);
  assert.equal(normalizeInput({ type: 'move', screen: 'left', x: -0.1, y: 0 }, displays), null);
});
test('按键白名单、扩展键和无效事件过滤', () => {
  assert.deepEqual(keyCode('ControlRight'), { vk: 163, extended: true });
  assert.deepEqual(keyCode('NumpadEnter'), { vk: 13, extended: true });
  assert.equal(keyCode('__proto__'), null);
  assert.equal(normalizeInput({ type: 'key', code: 'KeyA', down: 'false' }, []), null);
  assert.equal(normalizeInput({ type: 'exec', command: 'calc' }, []), null);
  assert.deepEqual(normalizeInput({ type: 'text', text: '中文\u0000测试' }, []), { type: 'text', text: '中文测试' });
});

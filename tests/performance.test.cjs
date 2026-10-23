'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { adaptive, captureSize, route } = require('../src/renderer/performance.js');
test('自适应码率快速退让、缓慢恢复，并限制采集 CPU 负载', () => {
  let state = adaptive(null, { bandwidth: 2500000 }, 0);
  assert.equal(state.bitrate, 2000000);
  state = adaptive(state, { bandwidth: 100000000 }, 2000);
  assert.equal(state.bitrate, 2200000);
  for (let n = 0; n < 3; n++) state = adaptive(state, { cpu: true }, 4000 + n * 2000);
  assert.equal(state.fps, 20);
  assert.equal(adaptive(state, { cpu: false }, 16000).fps, 20);
  assert.equal(adaptive(state, { cpu: false }, 18000).fps, 30);
  assert.equal(adaptive(state, { bandwidth: 1 }, 20000).bitrate, 1500000);
});
test('采集不放大、不改变宽高比，并能从低档恢复原始来源大小', () => {
  const source = { width: 3840, height: 2160 };
  assert.deepEqual(captureSize(source, { width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  assert.deepEqual(captureSize(source, source), source);
  assert.deepEqual(captureSize({ width: 1280, height: 720 }, source), { width: 1280, height: 720 });
});
test('对端 TURN 协议不可见时不能误报为 UDP', () => {
  const reports = new Map([['local', { protocol: 'udp' }], ['remote', { candidateType: 'relay' }]]);
  assert.equal(route(reports, { localCandidateId: 'local', remoteCandidateId: 'remote' }), '中继（对端传输协议未知）');
});

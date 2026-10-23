'use strict';
// 同一套纯函数供客户端与回归测试使用。
(function (root) {
  function adaptive(previous, { bandwidth, cpu }, now) {
    const state = { bitrate: 8000000, fps: 30, cpuSamples: 0, healthySince: now, ...previous };
    if (Number.isFinite(bandwidth) && bandwidth > 0) {
      const target = Math.max(1500000, Math.min(12000000, bandwidth * 0.8));
      state.bitrate = Math.round(target < state.bitrate ? target : Math.min(target, state.bitrate * 1.1));
    }
    state.cpuSamples = cpu ? state.cpuSamples + 1 : 0;
    if (cpu) state.healthySince = now;
    if (state.cpuSamples >= 3) { state.fps = state.fps > 20 ? 20 : 15; state.cpuSamples = 0; }
    else if (!cpu && now - state.healthySince >= 10000) { state.fps = state.fps < 20 ? 20 : 30; state.healthySince = now; }
    return state;
  }
  function captureSize(source, preset) {
    const ratio = Math.min(1, preset.width / source.width, preset.height / source.height);
    return { width: Math.max(2, Math.floor(source.width * ratio / 2) * 2), height: Math.max(2, Math.floor(source.height * ratio / 2) * 2) };
  }
  function route(reports, pair) {
    const local = reports.get(pair?.localCandidateId), remote = reports.get(pair?.remoteCandidateId);
    if (local?.candidateType === 'relay') return `中继${local.relayProtocol ? ' ' + local.relayProtocol.toUpperCase() : '（传输协议未知）'}`;
    if (remote?.candidateType === 'relay') return '中继（对端传输协议未知）';
    return `直连${local?.protocol ? ' ' + local.protocol.toUpperCase() : ''}`;
  }
  const api = { adaptive, captureSize, route };
  if (typeof module === 'object') module.exports = api; else root.YDeskPerformance = api;
})(globalThis);

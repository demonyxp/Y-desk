'use strict';
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const nodeServer = require('../../server/index.cjs');

// 用同一套协议和桌面测试验证两种后端，避免只测试 Go 自己构造的客户端。
function createSignalingServer(options = {}) {
  if (!process.env.YDESK_GO_SERVER) return nodeServer.createSignalingServer(options);
  let child;
  return {
    listen: () => new Promise((resolveReady, reject) => {
      const state = options.statePath || join(mkdtempSync(join(tmpdir(), 'ydesk-go-')), 'devices.json');
      const args = ['-listen', `${options.host || '127.0.0.1'}:${options.port ?? 21120}`, '-state', state,
        '-pending-timeout', `${options.pendingMs || 30000}ms`, '-attempt-window', `${options.attemptWindowMs || 60000}ms`,
        '-max-clients', String(options.maxClients || 1000)];
      child = spawn(resolve(process.env.YDESK_GO_SERVER), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Go 服务启动超时')); }, 10000);
      child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Go 服务退出 ${code}: ${errors}`)); });
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/listening on .*:(\d+)/);
        if (match) { clearTimeout(timer); resolveReady({ port: Number(match[1]) }); }
      });
    }),
    close: async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolveClosed, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Go 服务停止超时')); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolveClosed(); });
        child.kill();
      });
    }
  };
}
module.exports = { createSignalingServer };

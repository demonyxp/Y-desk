'use strict';

function createUpdates({ updater, enabled, installable, version, emit, isBusy, beforeInstall, installFailed }) {
  let state = { status: enabled ? 'idle' : 'unsupported', currentVersion: version, version: '', installable,
    progress: 0, message: enabled ? '启动后自动检查更新，也可手动检查。' : '开发模式不检查更新，请使用发布版。' };
  const getState = () => ({ ...state });
  const set = patch => { state = { ...state, ...patch }; emit(getState()); };
  const fail = () => {
    const installing = state.status === 'installing';
    set({ status: 'error', progress: 0, message: installing ? '安装启动失败，请重试或下载安装包。' : '更新失败，请检查 GitHub 网络连接后重试。' });
    if (installing) installFailed();
  };
  if (enabled) {
    // 只在用户操作后下载和安装，避免占用远程桌面带宽或在退出时意外升级。
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.on('error', fail);
    updater.on('update-available', info => set({ status: 'available', version: info.version, progress: 0,
      message: installable ? `发现新版本 v${info.version}，可以下载安装。` : `发现新版本 v${info.version}，便携版请下载新版替换。` }));
    updater.on('update-not-available', () => set({ status: 'current', version: '', message: '当前已是最新版本。' }));
    updater.on('download-progress', info => {
      const progress = Math.max(0, Math.min(100, Math.floor(Number(info.percent) || 0)));
      set({ status: 'downloading', progress, message: `正在下载更新 · ${progress}%` });
    });
    updater.on('update-downloaded', info => set({ status: 'downloaded', version: info.version, progress: 100,
      message: '下载完成。请在远程连接结束后点击“重启并安装”。' }));
  }
  return {
    getState,
    async check() {
      if (!enabled || ['checking', 'available', 'downloading', 'downloaded', 'installing'].includes(state.status)) return getState();
      set({ status: 'checking', message: '正在检查 GitHub 上的新版本…' });
      try { await updater.checkForUpdates(); } catch { fail(); }
      return getState();
    },
    async download() {
      if (!enabled || !installable || state.status !== 'available') return getState();
      set({ status: 'downloading', progress: 0, message: '正在下载更新 · 0%' });
      try { await updater.downloadUpdate(); } catch { fail(); }
      return getState();
    },
    install() {
      if (!enabled || !installable || state.status !== 'downloaded') return getState();
      // 主进程再次检查，不能只依赖页面按钮；下载期间可能建立新的远程连接。
      if (isBusy()) {
        set({ message: '远程连接或连接请求尚未结束，请先断开，再点击“重启并安装”。' });
        return getState();
      }
      set({ status: 'installing', message: '正在退出并安装更新…' });
      try { beforeInstall(); updater.quitAndInstall(false, true); } catch { fail(); }
      return getState();
    }
  };
}
module.exports = { createUpdates };

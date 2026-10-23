'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ydesk', {
  tools: (op, args) => ipcRenderer.invoke('tools', op, args),
  localDisplays: () => ipcRenderer.invoke('local-displays'),
  placeScreen: options => ipcRenderer.invoke('place-screen', options),
  testServer: url => ipcRenderer.invoke('test-server', url),
  recordConnected: () => ipcRenderer.invoke('record-connected'),
  screens: () => ipcRenderer.invoke('screens'),
  qualities: () => ipcRenderer.invoke('qualities'),
  settings: () => ipcRenderer.invoke('settings'),
  relay: options => ipcRenderer.invoke('relay', options),
  resume: () => ipcRenderer.invoke('resume'),
  connect: options => ipcRenderer.invoke('connect', options),
  approve: options => ipcRenderer.invoke('approve', options),
  signal: data => ipcRenderer.invoke('signal', data),
  capture: id => ipcRenderer.invoke('capture', id),
  leave: () => ipcRenderer.invoke('leave'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  fullscreen: enabled => ipcRenderer.invoke('fullscreen', enabled),
  screenFullscreen: enabled => ipcRenderer.invoke('screen-fullscreen', enabled),
  copyInvite: () => ipcRenderer.invoke('copy-invite'),
  copyDeviceId: () => ipcRenderer.invoke('copy-device-id'),
  updateState: () => ipcRenderer.invoke('updates-state'),
  updateCheck: () => ipcRenderer.invoke('updates-check'),
  updateDownload: () => ipcRenderer.invoke('updates-download'),
  updateInstall: () => ipcRenderer.invoke('updates-install'),
  updatePage: () => ipcRenderer.invoke('updates-page'),
  input: message => ipcRenderer.send('input', message),
  onEvent: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  }
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ydesk', {
  screens: () => ipcRenderer.invoke('screens'),
  qualities: () => ipcRenderer.invoke('qualities'),
  settings: () => ipcRenderer.invoke('settings'),
  resume: () => ipcRenderer.invoke('resume'),
  connect: options => ipcRenderer.invoke('connect', options),
  approve: options => ipcRenderer.invoke('approve', options),
  signal: data => ipcRenderer.invoke('signal', data),
  capture: id => ipcRenderer.invoke('capture', id),
  leave: () => ipcRenderer.invoke('leave'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  fullscreen: enabled => ipcRenderer.invoke('fullscreen', enabled),
  copyInvite: () => ipcRenderer.invoke('copy-invite'),
  copyDeviceId: () => ipcRenderer.invoke('copy-device-id'),
  input: message => ipcRenderer.send('input', message),
  onEvent: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  }
});

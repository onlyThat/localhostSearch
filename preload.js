'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 渲染进程只能通过这个白名单与主进程通信。 */
contextBridge.exposeInMainWorld('bridge', {
  getStatus: () => ipcRenderer.invoke('index:status'),
  buildIndex: (options) => ipcRenderer.invoke('index:build', options),
  search: (query, type, limit) => ipcRenderer.invoke('search:query', { query, type, limit }),
  open: (target) => ipcRenderer.invoke('file:open', target),
  reveal: (target) => ipcRenderer.invoke('file:reveal', target),
  copy: (target) => ipcRenderer.invoke('file:copy', target),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (next) => ipcRenderer.invoke('settings:set', next),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isAdmin: () => ipcRenderer.invoke('app:isAdmin'),
  elevate: () => ipcRenderer.invoke('app:elevate'),
  onStatus: (cb) => ipcRenderer.on('index:status', (_e, data) => cb(data)),
  onToast: (cb) => ipcRenderer.on('app:toast', (_e, text) => cb(text)),
  onError: (cb) => ipcRenderer.on('app:error', (_e, text) => cb(text)),
});

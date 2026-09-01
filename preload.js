'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 主进程主动推送的会话更新
  onSessions: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sessions:update', handler);
    return () => ipcRenderer.removeListener('sessions:update', handler);
  },
  // 主动拉取一次
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  // 一键重试
  retry: (payload) => ipcRenderer.invoke('session:retry', payload),
  // 聚焦某工作区的 Kiro 窗口
  focus: (payload) => ipcRenderer.invoke('session:focus', payload),
  // 配置读写
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  // 窗口控制
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getVersion: () => ipcRenderer.invoke('app:version'),
});

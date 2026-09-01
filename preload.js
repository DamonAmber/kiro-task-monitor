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
  // 套餐用量：主动拉取 + 订阅推送
  getUsage: () => ipcRenderer.invoke('usage:get'),
  onUsage: (cb) => {
    const handler = (_e, usage) => cb(usage);
    ipcRenderer.on('usage:update', handler);
    return () => ipcRenderer.removeListener('usage:update', handler);
  },
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
  // 更新：手动检查 / 一键重启安装 / 读取状态 / 订阅状态推送
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  onUpdateState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('update:state', handler);
    return () => ipcRenderer.removeListener('update:state', handler);
  },
});

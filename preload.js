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
  moveToApplications: () => ipcRenderer.invoke('app:moveToApplications'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  onUpdateState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('update:state', handler);
    return () => ipcRenderer.removeListener('update:state', handler);
  },
  // 系统授权 / 能力自检：读状态 / 主动复查 / 打开系统设置 / 订阅状态推送
  getPermissions: () => ipcRenderer.invoke('permissions:get'),
  recheckPermissions: () => ipcRenderer.invoke('permissions:recheck'),
  openPermissionSettings: (which) => ipcRenderer.invoke('permissions:openSettings', which),
  onPermissions: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('permissions:state', handler);
    return () => ipcRenderer.removeListener('permissions:state', handler);
  },
  // 诊断报告：生成并保存为 JSON（{ includeSensitive } → { ok, path } | { canceled } | { error }）
  generateDiagnostics: (options) => ipcRenderer.invoke('diagnostics:generate', options),
  // 局域网访问：读状态 / 开关 / 改端口 / 换 PIN / 订阅状态推送
  getWebState: () => ipcRenderer.invoke('web:state'),
  setWebEnabled: (enabled) => ipcRenderer.invoke('web:setEnabled', enabled),
  setWebPort: (port) => ipcRenderer.invoke('web:setPort', port),
  regenWeb: () => ipcRenderer.invoke('web:regen'),
  onWebState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('web:state', handler);
    return () => ipcRenderer.removeListener('web:state', handler);
  },
});

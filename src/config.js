'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  pollMs: 2000, // 轮询间隔
  activeWithinHours: 24, // 只显示最近 N 小时活跃的会话
  stuckSeconds: 120, // 运行中但 N 秒无写入 → 判定卡住
  notifyMinTurnSeconds: 25, // 完成通知的最短耗时门槛（过滤秒回的短轮次）

  notifyFailed: true, // 出错/卡住通知
  notifyDone: true, // 完成通知
  notifyWaiting: true, // 等待你确认/输入通知
  soundOnFailed: true, // 失败时播放提示音

  autoRetry: false, // 失败时自动重试（默认关，避免误操作）
  retryMessage: '继续', // 重试发送的内容
  retrySend: true, // 重试时是否自动回车发送

  bounds: null, // 浮窗位置（记忆）
  alwaysOnTop: true,
};

class Config {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...DEFAULT_CONFIG };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = { ...DEFAULT_CONFIG, ...raw };
    } catch {
      /* 使用默认值 */
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      /* ignore */
    }
  }

  get(k) {
    return this.data[k];
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }
}

module.exports = { Config, DEFAULT_CONFIG };

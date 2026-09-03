'use strict';

/**
 * 系统授权 / 运行能力自检。
 *
 * 目的：当用户反馈「监控识别不到活跃会话」「重试没反应」时，往往是缺少某项系统授权
 * 或环境能力（最常见的是 macOS「辅助功能」权限）。本模块把工具**真正依赖**的几项能力
 * 逐一体检，产出一份归一化报告，供主进程推给浮窗 / 局域网页面提醒用户去补齐授权。
 *
 * 依赖的能力（按对功能的影响分级）：
 *   1. 辅助功能授权（accessibility）—— 一键重试 / 聚焦窗口靠模拟按键，必须它；
 *      监控本身（识别状态）**不需要**它，但缺了「重试 / 聚焦」用不了。可被用户授予。
 *   2. 读取会话数据（~/.kiro/sessions）—— 监控的根基。读不到 = 什么都识别不到。
 *   3. sqlite3 可用 —— 读「哪些窗口/会话真正打开」和「套餐用量」都靠它；缺了会降级
 *      （不按打开状态过滤 / 不显示用量），但监控仍能跑。
 *   4. Kiro 窗口状态（storage.json）—— 用于剔除历史残留会话；读不到会降级为不过滤。
 *
 * 全程**只读**、绝不抛错：任何一步失败都归一化成 { ok:false, ... }，由调用方决定如何提示。
 */

const fs = require('fs');
const { execFile } = require('child_process');
const {
  SESSIONS_DIR,
  GLOBAL_STORAGE_JSON,
  KIRO_APP_SUPPORT,
} = require('./kiroPaths');

/**
 * 是否已获得 macOS「辅助功能」授权。
 * 用 Electron 的 systemPreferences.isTrustedAccessibilityClient(false) 探测——
 * 不产生副作用、不弹系统授权框（prompt=false）。
 * @returns {boolean|undefined} true=已授权 / false=未授权 / undefined=无法判断（非 macOS 或非主进程）
 */
function getAccessibilityGranted() {
  if (process.platform !== 'darwin') return undefined;
  try {
    // 仅主进程能拿到 systemPreferences；渲染进程 / CLI 里 require 会失败或无此方法。
    const { systemPreferences } = require('electron');
    if (systemPreferences && typeof systemPreferences.isTrustedAccessibilityClient === 'function') {
      return !!systemPreferences.isTrustedAccessibilityClient(false);
    }
  } catch {
    /* 非 electron 环境 → 未知 */
  }
  return undefined;
}

// sqlite3 是否可用一旦确认为真就不再反复探测（系统二进制不会中途消失）。
let _sqlite3Ok;
/** sqlite3 命令是否可用（读窗口面板 / 用量都要它）。 */
function checkSqlite3() {
  return new Promise((resolve) => {
    if (_sqlite3Ok === true) return resolve(true);
    execFile('sqlite3', ['-version'], { timeout: 2500 }, (err) => {
      const ok = !err;
      if (ok) _sqlite3Ok = true;
      resolve(ok);
    });
  });
}

/** ~/.kiro/sessions 是否可读，并统计其下的会话哈希目录数量。 */
function checkSessionsDir() {
  try {
    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    const count = entries.filter((e) => e.isDirectory()).length;
    return { ok: true, path: SESSIONS_DIR, count };
  } catch (e) {
    return { ok: false, path: SESSIONS_DIR, count: 0, error: (e && e.code) || 'READ_ERROR' };
  }
}

/**
 * Kiro 的窗口状态文件 storage.json 是否可读（用于剔除历史残留会话）。
 * 区分「无权限（EACCES/EPERM）」与「尚不存在（ENOENT，Kiro 还没运行过 / 未安装）」，
 * 后者不算授权问题，不该吓到用户。
 */
function checkKiroState() {
  try {
    fs.readFileSync(GLOBAL_STORAGE_JSON, 'utf8');
    return { ok: true, path: GLOBAL_STORAGE_JSON };
  } catch (e) {
    const code = (e && e.code) || 'READ_ERROR';
    let kiroInstalled = false;
    try {
      kiroInstalled = fs.existsSync(KIRO_APP_SUPPORT);
    } catch {
      kiroInstalled = false;
    }
    return { ok: false, path: GLOBAL_STORAGE_JSON, error: code, kiroInstalled };
  }
}

/** 会话目录读取失败的中文说明：区分「不存在」与「无权限」。 */
function sessionsDetail(s) {
  if (s.ok) return `可读，发现 ${s.count} 个会话目录`;
  if (s.error === 'ENOENT') return '未找到 ~/.kiro/sessions（Kiro 还没运行过？）';
  return '无法读取 ~/.kiro/sessions（可能需要授予「完全磁盘访问权限」）';
}

/** Kiro 窗口状态读取失败的中文说明。 */
function kiroStateDetail(s) {
  if (s.ok) return '可读，可精确识别当前打开的会话';
  if (s.error === 'ENOENT') return 'Kiro 窗口状态暂不可用（Kiro 未运行过？）· 将退回按活动时间显示';
  return '无法读取 Kiro 窗口状态 · 将退回按活动时间显示';
}

/**
 * 跑一遍全部自检，返回归一化报告。
 * @returns {Promise<object>} 见下方字段说明
 */
async function checkPermissions() {
  const isMac = process.platform === 'darwin';
  const accessibility = getAccessibilityGranted(); // true / false / undefined
  const [sqlite3ok, sessionsDir, kiroState] = [
    await checkSqlite3(),
    checkSessionsDir(),
    checkKiroState(),
  ];

  // —— 归一化成 UI 友好的检查项列表 —— //
  const items = [
    {
      id: 'accessibility',
      label: '辅助功能授权',
      ok: accessibility === true,
      unknown: accessibility === undefined,
      // required：缺了会让「重试 / 聚焦」不可用（但不影响识别）
      severity: 'required',
      canOpenSettings: true,
      detail:
        accessibility === true
          ? '已授权，可一键重试 / 聚焦窗口'
          : accessibility === undefined
          ? '无法确认授权状态'
          : '未授权。一键重试、聚焦窗口靠模拟按键，需要它。前往：系统设置 › 隐私与安全性 › 辅助功能，勾选本应用后重试。',
    },
    {
      id: 'sessions',
      label: '读取会话数据',
      ok: sessionsDir.ok,
      // critical：读不到就完全识别不了任何会话
      severity: 'critical',
      detail: sessionsDetail(sessionsDir),
    },
    {
      id: 'sqlite3',
      label: 'sqlite3 可用',
      ok: sqlite3ok,
      severity: 'optional',
      detail: sqlite3ok
        ? '可用，可读取打开的会话与套餐用量'
        : '不可用 · 无法精确过滤会话 / 显示用量（监控仍可运行）',
    },
    {
      id: 'kiroState',
      label: 'Kiro 窗口状态',
      ok: kiroState.ok,
      severity: 'optional',
      detail: kiroStateDetail(kiroState),
    },
  ];

  // 是否读得到会话（监控能否工作的最低要求）
  const canDetectSessions = sessionsDir.ok;
  // 会话目录因**无权限**读不了（区别于「不存在」）——这是硬阻塞、且可能靠授权解决
  const sessionsBlocked = !sessionsDir.ok && sessionsDir.error !== 'ENOENT';
  // 辅助功能明确未授权（仅 macOS）——可被用户授予的主要授权
  const needsAccessibility = isMac && accessibility === false;

  // —— 首要横幅：优先报「会话读不了」（最严重），其次报「缺辅助功能」 —— //
  let banner = null;
  if (sessionsBlocked) {
    banner = {
      level: 'error',
      action: 'diskAccess',
      text: '无法读取 Kiro 会话数据，监控无法工作。请在「系统设置 › 隐私与安全性 › 完全磁盘访问权限」中授权本应用。',
    };
  } else if (needsAccessibility) {
    banner = {
      level: 'warn',
      action: 'accessibility',
      text: '未授予「辅助功能」权限：一键重试、聚焦窗口用不了。点右侧去授权。',
    };
  }

  return {
    platform: process.platform,
    checkedAt: Date.now(),
    accessibility, // true / false / undefined
    sqlite3: sqlite3ok,
    sessionsDir, // { ok, path, count, error? }
    kiroState, // { ok, path, error?, kiroInstalled? }
    items,
    // 派生标志，便于调用方直接用
    canDetectSessions,
    needsAccessibility,
    sessionsBlocked,
    hasBlocking: sessionsBlocked || needsAccessibility,
    banner,
  };
}

module.exports = {
  checkPermissions,
  getAccessibilityGranted,
  // 便于测试 / 复用
  checkSqlite3,
  checkSessionsDir,
  checkKiroState,
};

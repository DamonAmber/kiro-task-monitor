'use strict';

/**
 * 读取「当前 Kiro 账号的套餐用量」。
 *
 * 数据来源：Kiro 会把订阅用量快照缓存在全局状态库里
 *   ~/Library/Application Support/Kiro/User/globalStorage/state.vscdb
 *     → ItemTable 中 key='kiro.kiroAgent' 的 value(JSON)
 *       → 字段 kiro.resourceNotifications.usageState:
 *         {
 *           usageBreakdowns: [{
 *             type: 'CREDIT', displayName, displayNamePlural,
 *             currency: { code, symbol },
 *             usageLimit,        // 套餐总额度
 *             currentUsage,      // 已用
 *             percentageUsed,    // 已用百分比
 *             currentOverages,   // 超出额度的数量
 *             overageCap,        // 超额封顶
 *             overageRate,       // 超额单价
 *             overageCharges,    // 已产生的超额费用
 *             resetDate,         // 额度重置日（ISO）
 *             unit, extraCredits
 *           }, ...],
 *           timestamp           // 该快照写入时间（ms）
 *         }
 *
 * 注意：这是 **Kiro 自己写入的缓存快照**，不是实时 API。只要 Kiro 在正常使用
 * 就会周期性刷新；本工具只做**只读**访问（与 openWindows.js 同一套 sqlite3 -readonly 手法），
 * 绝不写入 Kiro 的任何数据。任何一步失败都安全降级为 { ok:false }，绝不抛错。
 */

const { execFileSync } = require('child_process');
const { GLOBAL_STATE_DB } = require('./kiroPaths');

/** 从全局 state.vscdb 取出 kiro.kiroAgent 的原始 JSON 字符串（只读）。失败返回 null。 */
function readKiroAgentBlob(dbPath = GLOBAL_STATE_DB) {
  let out;
  try {
    out = execFileSync(
      'sqlite3',
      ['-readonly', dbPath, "SELECT value FROM ItemTable WHERE key='kiro.kiroAgent';"],
      { encoding: 'utf8', timeout: 2500, maxBuffer: 16 * 1024 * 1024 }
    );
  } catch {
    return null; // sqlite3 缺失 / DB 锁 / 读取异常 → 未知
  }
  const text = (out || '').trim();
  return text || null;
}

/** 把单个 breakdown 归一化成 UI 友好的对象。 */
function normalizeBreakdown(b) {
  const usageLimit = Number(b.usageLimit) || 0;
  const currentUsage = Number(b.currentUsage) || 0;
  const currentOverages = Number(b.currentOverages) || 0;
  const overageCharges = Number(b.overageCharges) || 0;
  // percentageUsed 优先用官方值，缺失时按 usage/limit 估算
  let percentageUsed = Number(b.percentageUsed);
  if (!Number.isFinite(percentageUsed)) {
    percentageUsed = usageLimit > 0 ? (currentUsage / usageLimit) * 100 : 0;
  }
  const remaining = usageLimit > 0 ? Math.max(usageLimit - currentUsage, 0) : 0;
  // 「额度已耗尽」判据：只取安全方向的信号——一个周期内真实用量只增不减、
  // 缓存值永远 ≤ 真实值，所以下面任一为真即可确信真实已耗尽（只会漏报、绝不误报）。
  // 拿不到真实超额数（Kiro 未落盘），故不暴露「超了多少」，只给布尔量给 UI 用。
  const overLimit =
    currentOverages > 0 ||
    overageCharges > 0 ||
    percentageUsed >= 100 ||
    (usageLimit > 0 && currentUsage >= usageLimit);
  const currency = b.currency && typeof b.currency === 'object' ? b.currency : { code: '', symbol: '' };

  return {
    type: b.type || '',
    unit: b.unit || '',
    displayName: b.displayName || 'Credit',
    displayNamePlural: b.displayNamePlural || (b.displayName ? b.displayName + 's' : 'Credits'),
    currency: { code: currency.code || '', symbol: currency.symbol || '' },
    usageLimit,
    currentUsage,
    remaining,
    percentageUsed,
    overLimit,
    currentOverages,
    overageCharges,
    overageRate: Number(b.overageRate) || 0,
    overageCap: Number(b.overageCap) || 0,
    resetDate: b.resetDate || null,
  };
}

/**
 * 读取并归一化套餐用量。
 * @param {string} [dbPath] 覆盖数据库路径（测试用）
 * @returns {{
 *   ok: boolean,                 // 是否成功读到用量数据
 *   primary: object|null,        // 主用量条（优先 CREDIT 类型，否则首个）
 *   breakdowns: object[],        // 全部用量条（未来可能不止一种）
 *   timestamp: number|null,      // 快照写入时间（ms）
 *   reason?: string,             // ok:false 时的原因（诊断用）
 * }}
 */
function readUsage(dbPath = GLOBAL_STATE_DB) {
  const fail = (reason) => ({ ok: false, primary: null, breakdowns: [], timestamp: null, reason });

  const blob = readKiroAgentBlob(dbPath);
  if (!blob) return fail('db-unreadable');

  let agent;
  try {
    agent = JSON.parse(blob);
  } catch {
    return fail('parse-error');
  }

  const usageState = agent && agent['kiro.resourceNotifications.usageState'];
  if (!usageState || typeof usageState !== 'object') return fail('no-usage-state');

  const raw = Array.isArray(usageState.usageBreakdowns) ? usageState.usageBreakdowns : [];
  const breakdowns = raw
    .filter((b) => b && typeof b === 'object')
    .map(normalizeBreakdown);
  if (!breakdowns.length) return fail('empty-breakdowns');

  // 主用量条：优先 CREDIT，否则取第一个
  const primary = breakdowns.find((b) => b.type === 'CREDIT') || breakdowns[0];
  const timestamp = Number(usageState.timestamp) || null;

  return { ok: true, primary, breakdowns, timestamp };
}

module.exports = {
  readUsage,
  // 便于测试 / 复用
  readKiroAgentBlob,
  normalizeBreakdown,
};

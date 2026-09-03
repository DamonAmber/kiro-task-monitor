'use strict';

/**
 * 生成「问题诊断报告」——当用户反馈「识别不到活跃会话 / 状态不对」时，一键导出一份
 * **结构化、默认脱敏**的 JSON，用户可直接发给维护者定位问题。
 *
 * 设计原则：
 * - 诊断这类过滤/识别问题**不需要**真实标题和路径，只需要结构信息（数量、状态、
 *   windowOpen、idleMs、是否匹配到打开的窗口、隐藏原因……）。故默认全部脱敏：
 *   标题只留 hash+长度，路径只留 hash，个人目录名一律不出现。
 * - 可选 includeSensitive=true 时才带上真实标题/路径（给不在意隐私、需要精确定位的用户）。
 * - 隐藏原因来自 watcher 的 visibilityDecision（与真实过滤规则同一真源），结论可信。
 * - 只读、绝不抛错。
 */

const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { STATE, visibilityDecision } = require('./watcher');
const { inspectOpenedWindows, normFolder } = require('./openWindows');
const { SESSIONS_DIR, GLOBAL_STORAGE_JSON } = require('./kiroPaths');
const fs = require('fs');

/** 稳定短哈希：同一输入永远得到同一 8 位十六进制，便于跨会话/跨字段对应，又不泄露原文。 */
function shortHash(s) {
  if (!s) return '';
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

/** 脱敏标题：敏感模式给原文，否则只留 hash + 长度。 */
function redactTitle(title, sensitive) {
  const t = title || '';
  if (sensitive) return { title: t };
  return { titleHash: shortHash(t), titleLen: t.length };
}

/** 脱敏路径：敏感模式给原文，否则只留 hash（个人目录名不出现）。 */
function redactPath(p, sensitive) {
  const v = p || '';
  if (sensitive) return v;
  return v ? '#' + shortHash(v) : '';
}

/** 把绝对路径里的 home 前缀替换成 ~（敏感模式保留原样）。 */
function tildify(p, sensitive) {
  if (!p) return '';
  if (sensitive) return p;
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function run(cmd, args, timeout = 2500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : (stdout || '').trim());
    });
  });
}

/** macOS 产品版本（如 14.5）。失败返回 ''。 */
async function macProductVersion() {
  if (process.platform !== 'darwin') return '';
  return (await run('sw_vers', ['-productVersion'])) || '';
}

/** 当前存活的 Kiro 进程数（匹配 Kiro.app/Contents/ 下的可执行）。失败返回 null。 */
async function kiroProcessCount() {
  const out = await run('pgrep', ['-f', 'Kiro\\.app/Contents/']);
  if (out == null) return null; // pgrep 缺失/异常
  const lines = out.split('\n').filter(Boolean);
  return lines.length;
}

const HIDDEN_REASON_LABEL = {
  'not-focused': '窗口已开但非当前聚焦会话（你开了「只看当前会话」）',
  'not-in-panels': '窗口已开但不在该窗口的会话面板列表里',
  'unmatched-active-stale': '未匹配到打开的窗口，且静默超过 30 分钟',
  'unmatched-inactive': '未匹配到打开的窗口，且非活跃状态（判为历史残留）',
};

/** 从 winCtx 提炼一份可安全序列化的窗口上下文（Set/Map → 计数/数组）。 */
function summarizeWinCtx(ctx, sensitive) {
  if (!ctx || !ctx.ok) {
    return { ok: false, note: '未能读取 Kiro 窗口状态 → 过滤已降级为不过滤' };
  }
  const openFolders = [...(ctx.openFolders || [])];
  const panels = [];
  for (const [folder, p] of ctx.panelsByFolder || []) {
    panels.push({
      folder: redactPath(folder, sensitive),
      readable: !!p.readable,
      openCount: p.ids ? p.ids.size : 0,
      hasFocused: !!p.focused,
    });
  }
  return {
    ok: true,
    kiroRunning: ctx.kiroRunning, // true / false / undefined
    openFoldersCount: openFolders.length,
    openFolders: openFolders.map((f) => redactPath(f, sensitive)),
    activeFolder: ctx.activeFolder ? redactPath(ctx.activeFolder, sensitive) : null,
    panels,
  };
}

/** 提炼与「过滤/识别」相关的关键配置项（其余配置与本问题无关，不导出）。 */
function pickConfig(config = {}) {
  return {
    onlyOpenSessions: config.onlyOpenSessions !== false,
    onlyFocusedSession: !!config.onlyFocusedSession,
    activeWithinHours: config.activeWithinHours ?? 24,
    stuckDetection: config.stuckDetection !== false,
    stuckSeconds: config.stuckSeconds ?? 240,
    toolStuckSeconds: config.toolStuckSeconds ?? 1800,
    watchClaude: config.watchClaude !== false,
    pollMs: config.pollMs ?? 2000,
  };
}

/** 权限自检结果的脱敏回显（丢弃绝对路径字段，避免泄露个人目录名）。 */
function redactPermissions(perm, sensitive) {
  if (!perm) return null;
  const sd = perm.sessionsDir || {};
  const ks = perm.kiroState || {};
  return {
    accessibility: perm.accessibility, // true/false/undefined
    sqlite3: perm.sqlite3,
    sessionsDir: { ok: sd.ok, count: sd.count, error: sd.error, path: sensitive ? sd.path : undefined },
    kiroState: { ok: ks.ok, error: ks.error, kiroInstalled: ks.kiroInstalled, path: sensitive ? ks.path : undefined },
    canDetectSessions: perm.canDetectSessions,
    needsAccessibility: perm.needsAccessibility,
    sessionsBlocked: perm.sessionsBlocked,
  };
}

/**
 * 组装诊断报告。
 * @param {object} o
 * @param {boolean} o.includeSensitive  是否包含真实标题/路径（默认脱敏）
 * @param {object}  o.versions          { app, electron, node }
 * @param {object}  o.config            config.data
 * @param {object}  o.permissions       最近一次权限自检结果
 * @param {object}  o.winCtx            当前窗口上下文（含 Set/Map）
 * @param {Array}   o.sessionsRaw       过滤前的 Kiro 会话全集（scanSessions onlyOpenSessions:false，已打标）
 * @param {Set}     o.shownKeys         当前实际显示的会话 key 集合
 * @param {number}  o.claudeShown       当前显示的 Claude 会话数
 * @returns {Promise<object>} 报告对象
 */
async function buildReport(o = {}) {
  const sensitive = !!o.includeSensitive;
  const config = o.config || {};
  const winCtx = o.winCtx || null;
  const raw = Array.isArray(o.sessionsRaw) ? o.sessionsRaw : [];
  const shownKeys = o.shownKeys instanceof Set ? o.shownKeys : new Set();
  const cfg = pickConfig(config);

  const [macVer, kiroProcs] = await Promise.all([macProductVersion(), kiroProcessCount()]);

  // —— 逐会话结构化事实 + 隐藏原因 —— //
  const hiddenByReason = {};
  let shownCount = 0;
  const sessions = raw.map((s) => {
    const decision = visibilityDecision(s, winCtx, {
      onlyOpen: cfg.onlyOpenSessions,
      onlyFocused: cfg.onlyFocusedSession,
    });
    const actuallyShown = shownKeys.has(s.key);
    if (decision.shown) shownCount += 1;
    else hiddenByReason[decision.reason] = (hiddenByReason[decision.reason] || 0) + 1;
    return {
      keyHash: shortHash(s.key),
      source: s.source || 'kiro',
      state: s.state,
      rawStatus: s.rawStatus || '',
      interrupted: !!s.interrupted,
      windowOpen: s.windowOpen, // true/false/undefined
      isActiveWindow: s.isActiveWindow,
      isFocused: !!s.isFocused,
      idleSec: Math.round((s.idleMs ?? 0) / 1000),
      elapsedSec: Math.round((s.elapsedMs ?? 0) / 1000),
      turnDurationSec: Math.round((s.turnDurationMs ?? 0) / 1000),
      hasRunningTool: !!s.runningTool,
      stopReason: s.state === STATE.FAILED ? s.stopReason || '' : '',
      workspaceMatched: s.windowOpen === true,
      visibility: decision, // { shown, reason }
      actuallyShown,
      workspace: redactPath(s.workspacePath, sensitive),
      ...redactTitle(s.title, sensitive),
    };
  });

  const winSummary = summarizeWinCtx(winCtx, sensitive);
  const opened = inspectOpenedWindows(); // 打开窗口构成（多根工作区检测）

  // —— 人类可读要点（放最前，方便一眼看懂） —— //
  const summary = [];
  summary.push(
    `App v${(o.versions && o.versions.app) || '?'} · Electron ${(o.versions && o.versions.electron) || '?'} · macOS ${macVer || '?'} · ${os.arch()}`
  );
  const perm = o.permissions;
  if (perm) {
    const acc = perm.accessibility === true ? '已授权' : perm.accessibility === false ? '未授权' : '未知';
    summary.push(
      `辅助功能: ${acc} · sqlite3: ${perm.sqlite3 ? '可用' : '不可用'} · 会话目录: ${
        perm.sessionsDir && perm.sessionsDir.ok ? '可读(' + perm.sessionsDir.count + ')' : '不可读'
      } · Kiro窗口状态: ${perm.kiroState && perm.kiroState.ok ? '可读' : '不可读'}`
    );
  }
  summary.push(`Kiro 进程数: ${kiroProcs == null ? '未知' : kiroProcs} · kiroRunning: ${winSummary.ok ? String(winSummary.kiroRunning) : '未知'}`);
  if (opened) {
    let line = `打开的窗口: 共 ${opened.total}（单文件夹 ${opened.folders} · 多根工作区 ${opened.multiRoot} · 空 ${opened.empty}）`;
    if (opened.multiRoot > 0) line += ' ⚠ 多根工作区窗口里的会话目前无法匹配，可能识别不到';
    summary.push(line);
  } else if (!winSummary.ok) {
    summary.push('打开的窗口: 读不到（storage.json 不可读）→ 已降级为不过滤');
  }
  const hiddenTotal = raw.length - shownCount;
  let scanLine = `Kiro 会话: 扫描到 ${raw.length}，规则判定显示 ${shownCount}，隐藏 ${hiddenTotal}`;
  if (hiddenTotal > 0) {
    const parts = Object.entries(hiddenByReason).map(
      ([r, n]) => `${HIDDEN_REASON_LABEL[r] || r} ×${n}`
    );
    scanLine += `（${parts.join(' · ')}）`;
  }
  summary.push(scanLine);
  summary.push(`当前显示的 Claude 会话: ${o.claudeShown || 0}`);
  summary.push(
    `关键配置: 只显示已打开=${cfg.onlyOpenSessions} · 只看当前=${cfg.onlyFocusedSession} · 显示最近=${cfg.activeWithinHours}h · 卡死兜底=${cfg.stuckDetection}`
  );
  // 命中概率最高的两个盲区，给出针对性提示
  const unmatched = (hiddenByReason['unmatched-active-stale'] || 0) + (hiddenByReason['unmatched-inactive'] || 0);
  if (unmatched > 0 && opened && opened.multiRoot > 0) {
    summary.push('提示: 有会话「未匹配到打开的窗口」，且存在多根工作区窗口——高度怀疑是多根工作区盲区。');
  } else if (hiddenByReason['unmatched-active-stale'] > 0) {
    summary.push('提示: 有活跃会话因「静默超 30 分钟且未匹配到窗口」被隐藏——可能是路径不匹配或窗口状态滞后。');
  }

  return {
    kind: 'kiro-task-monitor-diagnostics',
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    redacted: !sensitive, // true = 已脱敏（无真实标题/路径）
    summary,
    environment: {
      appVersion: (o.versions && o.versions.app) || '',
      electron: (o.versions && o.versions.electron) || '',
      node: (o.versions && o.versions.node) || '',
      platform: process.platform,
      osRelease: os.release(),
      macProductVersion: macVer,
      arch: os.arch(),
      kiroProcessCount: kiroProcs,
      sessionsDir: tildify(SESSIONS_DIR, sensitive),
      sessionsDirExists: safeExists(SESSIONS_DIR),
      storageJsonExists: safeExists(GLOBAL_STORAGE_JSON),
    },
    permissions: redactPermissions(perm, sensitive),
    config: cfg,
    openedWindows: opened, // {total, folders, multiRoot, empty, hasLastActive} | null
    windowContext: winSummary,
    filtering: {
      scanned: raw.length,
      shown: shownCount,
      hidden: hiddenTotal,
      hiddenByReason,
      claudeShown: o.claudeShown || 0,
    },
    sessions,
  };
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

module.exports = {
  buildReport,
  // 便于测试 / 复用
  shortHash,
  redactPermissions,
  summarizeWinCtx,
  pickConfig,
};

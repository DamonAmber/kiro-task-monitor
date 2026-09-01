'use strict';

const fs = require('fs');
const path = require('path');
const { SESSIONS_DIR } = require('./kiroPaths');
const { readOpenWindowContext, normFolder } = require('./openWindows');

/* ------------------------------------------------------------------ *
 * 状态常量
 * ------------------------------------------------------------------ */
const STATE = {
  RUNNING: 'running', // agent 正在执行
  WAITING: 'waiting', // 停下等待用户确认/输入（pending_interaction 或 waiting_on_user）
  DONE: 'done', // 一轮正常结束，轮到你了 / 任务完成
  FAILED: 'failed', // turn_end.stopReason ∈ error/failed/aborted —— 需要重试
  STUCK: 'stuck', // 运行中但长时间无任何写入 —— 疑似崩溃/卡死，需要重试
  CANCELLED: 'cancelled', // 用户主动取消
  IDLE: 'idle', // 无有效生命周期事件
};

// turn_end.stopReason 中代表“出错需重试”的取值
const FAIL_REASONS = new Set(['error', 'failed', 'aborted']);

// 默认阈值
const DEFAULTS = {
  stuckMs: 240 * 1000, // 运行中、且无工具在执行时，超 240s 无写入 → 判定 stuck
  toolStuckMs: 900 * 1000, // 有工具调用在执行（等结果）时用更长的宽限：超 15min 才判 stuck
  tailBytes: 512 * 1024, // 每个 messages.jsonl 读取末尾字节数（覆盖单个长 turn）
  activeWithinMs: 24 * 60 * 60 * 1000, // 只关心最近 24h 内有活动的会话
};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 读取文件末尾 maxBytes 字节，返回完整的 JSON 行数组（丢弃可能被截断的首行）。 */
function tailJsonLines(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return { lines: [], mtimeMs: 0, size: 0 };
  }
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    // 如果不是从文件开头读的，首行可能被截断，丢弃它
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        /* 忽略损坏行 */
      }
    }
    return { lines: out, mtimeMs: stat.mtimeMs, size };
  } catch {
    return { lines: [], mtimeMs: 0, size: 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function ts(v) {
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/** 读取并解析 session.json 元数据。 */
function readSessionMeta(sessionJsonPath) {
  try {
    const d = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
    const ws = Array.isArray(d.workspacePaths) && d.workspacePaths.length
      ? d.workspacePaths[0]
      : (Array.isArray(d.rootPaths) && d.rootPaths.length ? d.rootPaths[0] : '');
    return {
      id: d.id || '',
      title: d.title || '(未命名会话)',
      agentMode: d.agentMode || '',
      workspacePath: ws || '',
      workspaceName: ws ? path.basename(ws) : '',
      status: d.status || '', // in_progress / failed / completed / waiting_on_user / idle / ''
      modelId: d.modelId || '',
      createdAt: d.createdAt || '',
      lastModifiedAt: d.lastModifiedAt || '',
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 状态推导：基于 messages.jsonl 事件流 + session.json 状态
 * ------------------------------------------------------------------ */

function deriveState(meta, lines, mtimeMs, now, opts) {
  const stuckMs = (opts && opts.stuckMs) || DEFAULTS.stuckMs;
  const toolStuckMs = (opts && opts.toolStuckMs) || DEFAULTS.toolStuckMs;

  let lastTurnStartTs = 0;
  let lastTurnEnd = null; // { ts, stopReason }
  let lastEventTs = 0;
  let lastUserTs = 0;

  // 跟踪未解决的 pending_interaction（按 toolCallId 匹配，无 id 时用栈兜底）
  const pendingById = new Map();
  const pendingStack = [];
  let lastPending = null;

  // 跟踪未返回结果的 tool_call（toolCallId → {ts, name}）：
  // 有在途工具 = agent 正在等命令/构建等长任务的结果，属正常运行，卡住宽限更长。
  const inflightTools = new Map();

  for (const ev of lines) {
    const p = ev && ev.payload;
    if (!p) continue;
    const t = ts(ev.timestamp);
    if (t > lastEventTs) lastEventTs = t;

    switch (p.type) {
      case 'turn_start':
        lastTurnStartTs = t;
        break;
      case 'turn_end':
        lastTurnEnd = { ts: t, stopReason: p.stopReason || 'end_turn' };
        // 一轮结束，本轮遗留的在途工具作废
        inflightTools.clear();
        break;
      case 'tool_call':
        if (p.toolCallId) inflightTools.set(p.toolCallId, { ts: t, name: p.toolName || '' });
        break;
      case 'tool_result':
        if (p.toolCallId) inflightTools.delete(p.toolCallId);
        break;
      case 'user':
        lastUserTs = t;
        break;
      case 'pending_interaction': {
        const key = p.toolCallId || `#${pendingStack.length}`;
        const item = {
          ts: t,
          interactionType: p.interactionType || '',
          question: p.question || '',
        };
        pendingById.set(key, item);
        pendingStack.push(key);
        lastPending = item;
        break;
      }
      case 'interaction_resolved': {
        const key = p.toolCallId;
        if (key && pendingById.has(key)) {
          pendingById.delete(key);
        } else if (pendingStack.length) {
          pendingById.delete(pendingStack.pop());
        }
        break;
      }
      default:
        break;
    }
  }

  const lastActivityMs = Math.max(mtimeMs, lastEventTs);
  const idleFor = now - lastActivityMs;

  // 是否有一轮尚未结束
  const turnOpen =
    lastTurnStartTs > 0 && (!lastTurnEnd || lastTurnStartTs > lastTurnEnd.ts);

  // 当前是否有未解决的、且发生在最近的 pending_interaction（阻塞等待用户）
  const openPending =
    pendingById.size > 0 && lastPending && lastPending.ts >= lastTurnStartTs
      ? lastPending
      : null;

  // 本轮内是否有工具仍在执行（tool_call 未见 tool_result）
  let inflightToolTs = 0;
  let inflightToolName = '';
  for (const it of inflightTools.values()) {
    if (it.ts >= lastTurnStartTs && it.ts > inflightToolTs) {
      inflightToolTs = it.ts;
      inflightToolName = it.name;
    }
  }
  const hasInflightTool = inflightToolTs > 0;

  let state;
  let stopReason = lastTurnEnd ? lastTurnEnd.stopReason : '';
  let question = '';
  let elapsedMs = 0;

  if (turnOpen) {
    // 有工具在执行时用更长的卡住宽限（长命令/构建/测试属正常），避免误报
    const effectiveStuckMs = hasInflightTool ? toolStuckMs : stuckMs;
    if (openPending) {
      state = STATE.WAITING;
      question = openPending.question ? String(openPending.question).slice(0, 140) : '';
      elapsedMs = now - openPending.ts;
    } else if (idleFor > effectiveStuckMs) {
      state = STATE.STUCK;
      elapsedMs = now - lastTurnStartTs;
    } else {
      state = STATE.RUNNING;
      elapsedMs = now - lastTurnStartTs;
    }
  } else if (lastTurnEnd) {
    elapsedMs = lastTurnStartTs > 0 ? lastTurnEnd.ts - lastTurnStartTs : 0; // 本轮耗时
    if (FAIL_REASONS.has(stopReason)) {
      state = STATE.FAILED;
    } else if (stopReason === 'cancelled') {
      state = STATE.CANCELLED;
    } else {
      // end_turn / tool_use / 其它：一轮正常结束
      if (meta.status === 'waiting_on_user') state = STATE.WAITING;
      else state = STATE.DONE;
    }
  } else {
    // 没有任何 turn 事件，退回到 session.json 的 status
    switch (meta.status) {
      case 'failed':
        state = STATE.FAILED;
        break;
      case 'in_progress':
        state = idleFor > stuckMs ? STATE.STUCK : STATE.RUNNING;
        break;
      case 'waiting_on_user':
        state = STATE.WAITING;
        break;
      case 'completed':
        state = STATE.DONE;
        break;
      default:
        state = STATE.IDLE;
    }
  }

  return {
    state,
    stopReason,
    question,
    elapsedMs, // running/waiting：本轮已运行时长；done/failed：本轮耗时
    idleMs: idleFor, // 距上次写入时长（用于展示与卡死判断）
    runningTool: turnOpen && hasInflightTool ? (inflightToolName || 'tool') : '', // 正在执行的工具名
    lastActivityMs,
    turnDurationMs: lastTurnEnd && lastTurnStartTs > 0 && !turnOpen
      ? lastTurnEnd.ts - lastTurnStartTs
      : 0,
  };
}

/* ------------------------------------------------------------------ *
 * 扫描全部会话
 * ------------------------------------------------------------------ */

/** 列出所有 session.json 路径（sessions/<hash>/<sessionId>/session.json）。 */
function listSessionDirs() {
  const result = [];
  let hashDirs;
  try {
    hashDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const h of hashDirs) {
    if (!h.isDirectory()) continue;
    const hashPath = path.join(SESSIONS_DIR, h.name);
    let sessDirs;
    try {
      sessDirs = fs.readdirSync(hashPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessDirs) {
      if (!s.isDirectory()) continue;
      const dir = path.join(hashPath, s.name);
      const sessionJson = path.join(dir, 'session.json');
      const messages = path.join(dir, 'messages.jsonl');
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(sessionJson).mtimeMs;
      } catch {
        continue; // 没有 session.json，跳过
      }
      result.push({ dir, sessionJson, messages, workspaceHash: h.name, mtimeMs });
    }
  }
  return result;
}

/**
 * 依据「当前打开的 Kiro 窗口 + 每窗口聚焦会话」为会话打标并过滤。
 *
 * 每个会话会被标注：
 *   - windowOpen    该会话所属工作区当前是否有打开的 Kiro 窗口
 *   - isActiveWindow 该工作区是否为最近激活（前台）的窗口
 *   - isFocused     该会话是否为其窗口当前聚焦（激活）的那个会话
 *
 * 过滤规则（onlyOpenSessions 默认开启）：
 *   - 无法获取窗口状态（ctx.ok=false）→ 不过滤，回退到旧行为，避免监控变空白；
 *   - 工作区没有打开的窗口 → 剔除（这是历史残留会话的主要来源）；
 *   - 窗口开着但面板信息读不到（readable=false）→ 保守保留，避免漏报；
 *   - onlyFocusedSession=true → 每个窗口只保留聚焦的那个会话；
 *   - 否则保留该窗口侧边栏里打开的所有会话。
 *
 * @param {Array} sessions 待处理会话
 * @param {object} opts { onlyOpenSessions, onlyFocusedSession, windowContext }
 * @returns {Array} 过滤后的会话（已就地打标）
 */
function applyOpenWindowFilter(sessions, opts = {}) {
  const onlyOpen = opts.onlyOpenSessions !== false; // 默认开启
  const onlyFocused = !!opts.onlyFocusedSession;

  let ctx = opts.windowContext;
  if (ctx === undefined) {
    // 只在需要时读取（也允许调用方注入，便于测试）
    try {
      ctx = readOpenWindowContext();
    } catch {
      ctx = null;
    }
  }

  // 打标（即使不过滤也提供信息，便于 UI 高亮聚焦会话）
  for (const s of sessions) {
    const f = normFolder(s.workspacePath);
    if (ctx && ctx.ok) {
      s.windowOpen = ctx.openFolders.has(f);
      s.isActiveWindow = !!f && f === ctx.activeFolder;
      const panels = ctx.panelsByFolder.get(f);
      s.isFocused = !!(panels && panels.readable && s.id && s.id === panels.focused);
    } else {
      s.windowOpen = undefined;
      s.isActiveWindow = undefined;
      s.isFocused = false;
    }
  }

  if (!onlyOpen || !ctx || !ctx.ok) return sessions; // 降级：不过滤

  return sessions.filter((s) => {
    const f = normFolder(s.workspacePath);
    if (!ctx.openFolders.has(f)) return false; // 工作区窗口未打开 → 残留会话
    const panels = ctx.panelsByFolder.get(f);
    if (!panels || !panels.readable) return true; // 窗口开着但面板未知 → 保守保留
    if (onlyFocused) return !!s.id && s.id === panels.focused;
    return !!s.id && panels.ids.has(s.id);
  });
}

/**
 * 扫描并返回每个（最近活跃的）会话的状态快照。
 * @param {object} opts { activeWithinMs, stuckMs, tailBytes, now, onlyOpenSessions, onlyFocusedSession, windowContext }
 * @returns {Array<Session>} 按最近活动时间倒序
 */
function scanSessions(opts = {}) {
  const now = opts.now || Date.now();
  const activeWithinMs = opts.activeWithinMs ?? DEFAULTS.activeWithinMs;
  const stuckMs = opts.stuckMs ?? DEFAULTS.stuckMs;
  const toolStuckMs = opts.toolStuckMs ?? DEFAULTS.toolStuckMs;
  const tailBytes = opts.tailBytes ?? DEFAULTS.tailBytes;

  const dirs = listSessionDirs();
  let out = [];

  for (const d of dirs) {
    // 先用 messages.jsonl 或 session.json 的 mtime 做粗过滤
    let msgMtime = 0;
    try {
      msgMtime = fs.statSync(d.messages).mtimeMs;
    } catch {
      msgMtime = 0;
    }
    const recentMtime = Math.max(d.mtimeMs, msgMtime);
    if (activeWithinMs > 0 && now - recentMtime > activeWithinMs) continue;

    const meta = readSessionMeta(d.sessionJson);
    if (!meta) continue;

    const { lines, mtimeMs } = tailJsonLines(d.messages, tailBytes);
    const derived = deriveState(meta, lines, Math.max(mtimeMs, msgMtime), now, { stuckMs, toolStuckMs });

    out.push({
      key: meta.id || d.dir,
      id: meta.id,
      title: meta.title,
      agentMode: meta.agentMode,
      workspacePath: meta.workspacePath,
      workspaceName: meta.workspaceName,
      modelId: meta.modelId,
      rawStatus: meta.status,
      dir: d.dir,
      messagesPath: d.messages,
      ...derived,
    });
  }

  // —— 只保留「当前 Kiro 窗口里真正打开/激活的会话」，剔除历史残留 —— //
  out = applyOpenWindowFilter(out, opts);

  // 排序（从上到下）：
  //   1) 需要处理的（failed/stuck）始终置顶——这是工具的核心价值，别被埋没；
  //   2) 其次是你当前聚焦（激活）的会话——「把活跃会话往前排」；
  //   3) 再按状态优先级（waiting → running → done → …）；
  //   4) 最后按最近活动时间倒序。
  const priority = {
    [STATE.FAILED]: 0,
    [STATE.STUCK]: 1,
    [STATE.WAITING]: 2,
    [STATE.RUNNING]: 3,
    [STATE.DONE]: 4,
    [STATE.CANCELLED]: 5,
    [STATE.IDLE]: 6,
  };
  const needsAttention = (s) => (s.state === STATE.FAILED || s.state === STATE.STUCK ? 0 : 1);
  out.sort((a, b) => {
    const aa = needsAttention(a);
    const ab = needsAttention(b);
    if (aa !== ab) return aa - ab;
    const fa = a.isFocused ? 0 : 1;
    const fb = b.isFocused ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const pa = priority[a.state] ?? 9;
    const pb = priority[b.state] ?? 9;
    if (pa !== pb) return pa - pb;
    return b.lastActivityMs - a.lastActivityMs;
  });

  return out;
}

module.exports = {
  STATE,
  DEFAULTS,
  FAIL_REASONS,
  scanSessions,
  deriveState,
  readSessionMeta,
  tailJsonLines,
  listSessionDirs,
  applyOpenWindowFilter,
};

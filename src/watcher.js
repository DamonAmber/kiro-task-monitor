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
  toolStuckMs: 1800 * 1000, // 有工具调用在执行（等结果）时用更长的宽限：超 30min 才判 stuck
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

/**
 * 解析 messages.jsonl 事件流，抽取用于状态判定的信号。这一步是「重活」
 * （遍历已解析的事件），与 decideState 分离后，scanSessions 可按文件 mtime
 * 缓存信号、跳过对未变化会话的重复读取与解析（性能优化）。
 */
function parseSignals(lines) {
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

  // 本轮内是否有工具仍在执行（tool_call 未见 tool_result，且发生在最近一轮）
  let inflightToolTs = 0;
  let inflightToolName = '';
  for (const it of inflightTools.values()) {
    if (it.ts >= lastTurnStartTs && it.ts > inflightToolTs) {
      inflightToolTs = it.ts;
      inflightToolName = it.name;
    }
  }

  return {
    lastTurnStartTs,
    lastTurnEnd,
    lastEventTs,
    lastUserTs,
    pendingCount: pendingById.size,
    lastPending,
    inflightToolTs,
    inflightToolName,
  };
}

/**
 * 由「信号 + session.json.status + 时间」判定会话状态。与 parseSignals 分离，
 * 便于缓存信号；本函数很轻（不读文件、不解析），可每轮用最新的 now 重算。
 */
function decideState(meta, sig, mtimeMs, now, opts) {
  const stuckMs = (opts && opts.stuckMs) || DEFAULTS.stuckMs;
  const toolStuckMs = (opts && opts.toolStuckMs) || DEFAULTS.toolStuckMs;
  // 卡死超时兜底开关：关掉后完全不按时长判 stuck，只保留失败事件(turn_end)驱动的判定
  const stuckDetection = !(opts && opts.stuckDetection === false);
  // ① 确定性中断：主进程明确告知 Kiro 未在运行（kiroRunning===false）时，
  //    运行中的会话即为「已中断」（进程被杀/崩溃/退出），无需靠超时去猜。
  const kiroRunning = opts ? opts.kiroRunning : undefined;

  const {
    lastTurnStartTs,
    lastTurnEnd,
    lastEventTs,
    lastPending,
    pendingCount,
    inflightToolTs,
    inflightToolName,
  } = sig;

  const lastActivityMs = Math.max(mtimeMs, lastEventTs);
  const idleFor = now - lastActivityMs;

  // 是否有一轮尚未结束
  const turnOpen =
    lastTurnStartTs > 0 && (!lastTurnEnd || lastTurnStartTs > lastTurnEnd.ts);

  // 当前是否有未解决的、且发生在最近的 pending_interaction（阻塞等待用户）
  const openPending =
    pendingCount > 0 && lastPending && lastPending.ts >= lastTurnStartTs
      ? lastPending
      : null;

  const hasInflightTool = inflightToolTs > 0;

  // 有工具在执行时用更长的卡住宽限（慢查询/长命令/构建/测试属正常），避免误报。
  // 两条判定路径（turnOpen 与 status 兜底）都用它，防止长 turn 的 turn_start
  // 滚出 tail 窗口时错误地退回到较短阈值。
  const effectiveStuckMs = hasInflightTool ? toolStuckMs : stuckMs;

  let state;
  let stopReason = lastTurnEnd ? lastTurnEnd.stopReason : '';
  let question = '';
  let elapsedMs = 0;

  if (turnOpen) {
    // 事件流显示当前有一轮正在进行（turn_start 在 tail 里、且晚于最后的 turn_end）——最直接的信号
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
  } else if (meta.status === 'in_progress') {
    // Kiro 权威状态说「仍在进行」，但事件流里看不到未闭合的 turn。
    // 最常见的原因：会话很长，当前这一轮的 turn_start 已滚出 tail 窗口（512KB），
    // 而 tail 里只留着上一轮的 turn_end，导致「看起来已闭合」。此时**以 session.json.status
    // 为准**，判定为运行中（或按阈值判卡住），避免把正在跑的会话误判成「已完成」
    // 而从列表中消失——这正是用户反馈「Kiro 在跑却不显示活跃会话」的主因之一。
    if (openPending) {
      state = STATE.WAITING;
      question = openPending.question ? String(openPending.question).slice(0, 140) : '';
      elapsedMs = now - openPending.ts;
    } else {
      state = idleFor > effectiveStuckMs ? STATE.STUCK : STATE.RUNNING;
      // 当前轮的 turn_start 不可见时耗时未知，置 0（UI 不显示时长），状态仍准
      elapsedMs = 0;
    }
  } else if (meta.status === 'waiting_on_user') {
    // Kiro 权威状态说「等待用户」——即便事件流截断也以此为准
    state = STATE.WAITING;
    if (openPending) {
      question = openPending.question ? String(openPending.question).slice(0, 140) : '';
      elapsedMs = now - openPending.ts;
    }
  } else if (lastTurnEnd) {
    elapsedMs = lastTurnStartTs > 0 ? lastTurnEnd.ts - lastTurnStartTs : 0; // 本轮耗时
    if (FAIL_REASONS.has(stopReason)) {
      state = STATE.FAILED;
    } else if (stopReason === 'cancelled') {
      state = STATE.CANCELLED;
    } else {
      // end_turn / tool_use / 其它：一轮正常结束（in_progress/waiting_on_user 已在上面处理）
      state = STATE.DONE;
    }
  } else {
    // 既无 turn 事件、status 也非 in_progress/waiting_on_user（已在上面处理）
    switch (meta.status) {
      case 'failed':
        state = STATE.FAILED;
        break;
      case 'completed':
        state = STATE.DONE;
        break;
      default:
        state = STATE.IDLE;
    }
  }

  // ① 确定性中断：确知 Kiro 未在运行，却判为运行中/卡住 → 标记为「已中断」。
  //    这不是靠超时猜的，而是进程层面确认（窗口/进程已消失），准确且即时。
  let interrupted = false;
  if (kiroRunning === false && (state === STATE.RUNNING || state === STATE.STUCK)) {
    state = STATE.STUCK;
    interrupted = true;
  }

  // 关闭超时兜底时：把"疑似卡住"降级为"运行中"，只让失败事件来触发告警；
  // 但**确定性中断**不降级——它是确知的中断，不受该开关影响。
  if (state === STATE.STUCK && !stuckDetection && !interrupted) state = STATE.RUNNING;

  return {
    state,
    stopReason,
    question,
    interrupted, // true = 确知 Kiro 已不在运行导致的中断（区别于超时猜测的 stuck）
    elapsedMs, // running/waiting：本轮已运行时长；done/failed：本轮耗时
    idleMs: idleFor, // 距上次写入时长（用于展示与卡死判断）
    runningTool:
      hasInflightTool && (state === STATE.RUNNING || state === STATE.STUCK)
        ? inflightToolName || 'tool'
        : '', // 正在执行的工具名（有在途工具时）
    lastActivityMs,
    turnDurationMs: lastTurnEnd && lastTurnStartTs > 0 && !turnOpen
      ? lastTurnEnd.ts - lastTurnStartTs
      : 0,
  };
}

/** 兼容包装：读事件流 → 解析信号 → 判定状态。测试与 CLI 仍可直接用它。 */
function deriveState(meta, lines, mtimeMs, now, opts) {
  return decideState(meta, parseSignals(lines), mtimeMs, now, opts);
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

  // 「活跃 / 需要你处理」的会话：运行中 · 等待你 · 出错 · 卡住。
  const ATTENTION = new Set([STATE.RUNNING, STATE.WAITING, STATE.FAILED, STATE.STUCK]);
  const isActive = (s) => ATTENTION.has(s.state);
  // 窗口状态识别不到该会话所属工作区时的护栏：只显示「此刻确实存活」的活跃会话。
  // 取值放宽到 30min，覆盖「正在跑长工具、长时间无写入」的运行会话（否则会被误当残留隐藏），
  // 同时仍能滤掉早已结束的老残留。
  const GRACE_MS = 30 * 60 * 1000;
  const recentlyActive = (s) => (s.idleMs ?? Infinity) <= GRACE_MS;

  return sessions.filter((s) => {
    const f = normFolder(s.workspacePath);
    const windowOpen = ctx.openFolders.has(f);

    if (windowOpen) {
      // 窗口就开着 → 不是历史残留。窗口里的**活跃会话一律显示**，无论 Kiro 的面板记录
      // 是否已收录它、也无论静默多久（Kiro 的窗口/面板状态是周期性落盘、会滞后的，
      // 刚打开 App 时正在跑的会话常常还没被写进面板列表——这是用户反馈的另一主因）。
      if (isActive(s)) return true;
      const panels = ctx.panelsByFolder.get(f);
      if (!panels || !panels.readable) return true; // 面板未知 → 保守保留
      if (onlyFocused) return !!s.id && s.id === panels.focused;
      return !!s.id && panels.ids.has(s.id);
    }

    // 该会话工作区没匹配到打开的窗口：可能是历史残留，也可能是窗口状态读取滞后 /
    // 多根工作区 / 路径不匹配等。仅当会话此刻确实存活（活跃状态 + 近期有活动）才显示，
    // 兼顾「过滤残留」与「绝不漏掉正在跑的会话」。
    return isActive(s) && recentlyActive(s);
  });
}

// ⑤ 扫描缓存：dir → { sMtime, mMtime, mSize, meta, signals }。
// 文件（session.json / messages.jsonl）的 mtime+size 未变化时，复用已解析的 meta 与信号，
// 跳过读文件与 JSON 解析（最贵的部分）；只用最新的 now 重跑轻量的 decideState。
const _scanCache = new Map();

/**
 * 扫描并返回每个（最近活跃的）会话的状态快照。
 * @param {object} opts { activeWithinMs, stuckMs, tailBytes, now, onlyOpenSessions, onlyFocusedSession, windowContext, kiroRunning }
 * @returns {Array<Session>} 按最近活动时间倒序
 */
function scanSessions(opts = {}) {
  const now = opts.now || Date.now();
  const activeWithinMs = opts.activeWithinMs ?? DEFAULTS.activeWithinMs;
  const stuckMs = opts.stuckMs ?? DEFAULTS.stuckMs;
  const toolStuckMs = opts.toolStuckMs ?? DEFAULTS.toolStuckMs;
  const stuckDetection = opts.stuckDetection !== false;
  const tailBytes = opts.tailBytes ?? DEFAULTS.tailBytes;

  const dirs = listSessionDirs();
  const seen = new Set(); // 本轮见到的 dir，用于清理缓存里已消失的会话
  let out = [];

  for (const d of dirs) {
    // 先用 messages.jsonl 或 session.json 的 mtime 做粗过滤
    let msgMtime = 0;
    let msgSize = 0;
    try {
      const st = fs.statSync(d.messages);
      msgMtime = st.mtimeMs;
      msgSize = st.size;
    } catch {
      msgMtime = 0;
      msgSize = 0;
    }
    const recentMtime = Math.max(d.mtimeMs, msgMtime);
    if (activeWithinMs > 0 && now - recentMtime > activeWithinMs) continue;

    // ⑤ 命中缓存（session.json 与 messages.jsonl 都未变化）→ 复用 meta + 信号，跳过读+解析
    let entry = _scanCache.get(d.dir);
    if (!entry || entry.sMtime !== d.mtimeMs || entry.mMtime !== msgMtime || entry.mSize !== msgSize) {
      const m = readSessionMeta(d.sessionJson);
      if (!m) {
        _scanCache.delete(d.dir);
        continue;
      }
      const { lines } = tailJsonLines(d.messages, tailBytes);
      entry = {
        sMtime: d.mtimeMs,
        mMtime: msgMtime,
        mSize: msgSize,
        meta: m,
        signals: parseSignals(lines),
      };
      _scanCache.set(d.dir, entry);
    }
    seen.add(d.dir);
    const meta = entry.meta;

    const derived = decideState(meta, entry.signals, msgMtime, now, {
      stuckMs,
      toolStuckMs,
      stuckDetection,
      kiroRunning: opts.kiroRunning, // ① 中断判定（undefined 时不触发，保持安全）
    });

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

  // 清理缓存里本轮未再出现的会话（已被删除 / 超出活跃窗口），避免无限增长
  if (_scanCache.size > seen.size) {
    for (const k of _scanCache.keys()) if (!seen.has(k)) _scanCache.delete(k);
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
  parseSignals,
  decideState,
  readSessionMeta,
  tailJsonLines,
  listSessionDirs,
  applyOpenWindowFilter,
};

'use strict';

/**
 * DeepSeek Harness（`dsh web`）会话的**只读**监控。产出与 watcher.js 的 Kiro 会话、
 * claudeWatcher.js 的 Claude 会话**同形状**的对象（多一个 source:'dsh'），可被 UI /
 * 通知 / 排序统一处理。全程只读 ~/.dsh，绝不写入 dsh 的任何数据。
 *
 * 架构与其它两者的关键差异：dsh web 是**单进程多会话**——一个 `node dsh web` 服务
 * 管理所有会话，没有 per-session 进程。因此「某会话是否在跑」不能靠 per-session pgrep，
 * 而是用**会话事件文件的新鲜度**当活跃探针；`dsh web` 进程整体是否存活则用 pgrep 兜底
 * 判「中断」。
 *
 * 数据来源（全部只读，默认 DSH_HOME=~/.dsh，可被环境变量覆盖）：
 *   1) 事件流（**主源、权威**）：
 *      sessions/<编码cwd>/session-<id>/session.jsonl.zstd
 *      —— zstd「多帧拼接」的 JSONL（每条事件一帧、追加写入）。用 fzstd 一次性解压整文件
 *      （按 mtime+size 缓存，未变化不重复解压；超大文件只解压尾部帧窗口）。事件类型与 Kiro
 *      的 messages.jsonl 几乎 1:1：
 *        turn/start · turn/end(data.reason.kind: completed|error|aborted|interrupted)
 *        step/start · step/end · tool/call · tool/result（按 callId 配对，判在途工具）
 *        approval/asked · approval/decided（按 id 配对，未配对=等你授权）
 *        user/message（首条可作标题回退）
 *   2) 投影缓存（**降级兜底 + 元数据**）：
 *      storages/session_projcache/sessions/<id>.json
 *      —— 明文 JSON 快照，约 5s 刷新一次、**会滞后于事件流**（实测投影仍显示 openTurn
 *      而事件流其实已 turn/end）。故仅在事件流读不到时用它兜底状态；平时只取其 identity.cwd
 *      与 rows.title.val 作元数据。（注意：storages/session_projcache.json 合并文件更旧、
 *      字段更少，不用它。）
 *   3) 工作区索引：storages/workspace.json —— sessionId→工作区 path/title，及 archived 集合。
 *
 * 只读、不做重试/聚焦（会话在浏览器里，聚焦原生窗口无意义）；schema 全部容错、读不到即降级或跳过，
 * 绝不抛错。dsh 的投影/事件格式是其内部未公开格式，版本迭代快，改动务必保持容错。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const fzstd = require('fzstd');
const { STATE, buildActivity } = require('./watcher');

const HOME = os.homedir();
// DSH_HOME 默认 ~/.dsh，允许环境变量覆盖（与 dsh 自身一致）
const DSH_HOME =
  process.env.DSH_HOME && String(process.env.DSH_HOME).trim()
    ? String(process.env.DSH_HOME).trim()
    : path.join(HOME, '.dsh');
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions');
const PROJCACHE_SESSIONS_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const WORKSPACE_FILE = path.join(DSH_HOME, 'storages', 'workspace.json');

// 阈值（沿用与 Kiro 一致的语义，主进程会用 config 覆盖）
const DEFAULTS = {
  activeWithinMs: 24 * 60 * 60 * 1000, // 只关心最近 24h 活跃的会话
  stuckMs: 240 * 1000, // 运行中、无在途工具时超 240s 无写入 → 卡住
  toolStuckMs: 1800 * 1000, // 有工具在执行时的更长宽限
};
// 解压保护：单文件超过该压缩体积时只解压尾部窗口（避免病态巨型会话拖慢轮询）
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const TAIL_WINDOW_BYTES = 4 * 1024 * 1024;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // zstd 帧起始魔数
const ACTIVITY_MAX_TS = 200; // 迷你时间线保留的事件时间戳个数上限

// turn/end.reason.kind 语义映射
const FAIL_KINDS = new Set(['error', 'failed']); // 出错，需你处理
const CANCEL_KINDS = new Set(['aborted', 'interrupted', 'cancelled']); // 你主动停止

/* ------------------------------------------------------------------ *
 * dsh web 进程存活（单进程多会话：探测服务整体是否在跑，用于「中断」兜底）
 * ------------------------------------------------------------------ */
function _aliveFromErr(err) {
  if (!err) return true; // 有匹配进程
  if (err.code === 1 || err.status === 1) return false; // 正常执行、零匹配
  return undefined; // pgrep 缺失/异常 → 未知（安全：不判中断）
}

/** 同步探测 `dsh web` 服务是否存活。true/false/undefined(未知)。 */
function getDshServerAliveSync() {
  try {
    execFileSync('pgrep', ['-f', 'dsh web'], { encoding: 'utf8', timeout: 2000 });
    return true;
  } catch (e) {
    return _aliveFromErr(e);
  }
}

/** 异步版本（供主进程定时刷新，不阻塞轮询）。 */
function getDshServerAliveAsync() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', 'dsh web'], { encoding: 'utf8', timeout: 2000 }, (err) => {
      resolve(_aliveFromErr(err));
    });
  });
}

/* ------------------------------------------------------------------ *
 * zstd 解压（多帧拼接 → JSONL 文本）
 * ------------------------------------------------------------------ */
/**
 * 流式解压一段（可能含多帧的）zstd 字节。⚠️ 关键：会话正在写入时，文件末尾常有一个**不完整帧**，
 * 一次性 fzstd.decompress 会因 "unexpected EOF" 抛错并丢弃全部结果；流式 Decompress 则在抛错前
 * 已通过 ondata 逐帧交付了所有**完整帧**的输出——据此保住除末尾残帧外的全部事件（活跃会话必备）。
 * @returns {string} 已成功解出的 UTF-8 文本；一个完整帧都没有时抛错（交由上层降级到投影缓存）。
 */
function streamingDecompress(input) {
  const chunks = [];
  const d = new fzstd.Decompress((chunk) => chunks.push(Buffer.from(chunk)));
  try {
    d.push(new Uint8Array(input), true);
  } catch (e) {
    if (!chunks.length) throw e; // 连一个完整帧都没有 → 确实无法解压
    // 否则：末尾不完整帧（正在写入），丢弃残帧、保留已解出的完整帧
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 解压整文件；超大文件从尾部窗口的一个帧边界起解压（帧相互独立，可从任意帧头解压）。 */
function decompressSession(buf) {
  if (buf.length <= MAX_COMPRESSED_BYTES) {
    return streamingDecompress(buf);
  }
  // 超大文件：从尾部窗口内的帧边界起解压，误命中魔数则试下一个
  let idx = buf.indexOf(ZSTD_MAGIC, Math.max(0, buf.length - TAIL_WINDOW_BYTES));
  while (idx >= 0) {
    try {
      const text = streamingDecompress(buf.subarray(idx));
      if (text) return text;
    } catch {
      /* 该边界不是真帧头，继续找下一个 */
    }
    idx = buf.indexOf(ZSTD_MAGIC, idx + 4);
  }
  // 兜底：从头流式解压整文件
  return streamingDecompress(buf);
}

/* ------------------------------------------------------------------ *
 * 事件流解析 → 状态信号（对标 watcher.parseSignals）
 * ------------------------------------------------------------------ */
/**
 * 顺序遍历事件（文件按追加顺序落盘），维护「当前回合是否未闭合、在途工具、未决授权」等信号。
 * @param {string} text 解压后的 JSONL 文本
 */
function parseDshEvents(text) {
  let openTurn = false;
  let curTurnStartTs = 0;
  let lastEndReason = '';
  let lastEndTs = 0;
  let lastTurnDurationMs = 0;
  let lastEventTs = 0;
  let firstUserText = '';
  const recentEventTs = [];

  const inflightTools = new Map(); // callId → { ts, name }
  const pendingApproval = new Map(); // id → { ts, toolName, reason }

  const lines = text.split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue; // 忽略损坏行
    }
    const type = ev && ev.type;
    if (!type) continue;
    const d = (ev && ev.data) || {};
    const t = Number(ev.time) || 0;
    if (t) {
      if (t > lastEventTs) lastEventTs = t;
      recentEventTs.push(t);
    }

    switch (type) {
      case 'turn/start':
        openTurn = true;
        curTurnStartTs = t || curTurnStartTs;
        break;
      case 'turn/end':
        openTurn = false;
        lastEndReason = (d.reason && d.reason.kind) || 'completed';
        lastEndTs = t || lastEndTs;
        lastTurnDurationMs = curTurnStartTs && t ? Math.max(0, t - curTurnStartTs) : 0;
        inflightTools.clear(); // 一轮结束，遗留在途工具作废
        break;
      case 'tool/call':
        if (d.callId) inflightTools.set(d.callId, { ts: t, name: d.name || '' });
        break;
      case 'tool/result': {
        // ⚠️ tool/result 的 callId 不在 data.callId，而在 data.message.source.callId
        //（call 用 data.callId，result 用 message.source.callId / content[].toolCallId）。
        const cid = resultCallId(d);
        if (cid) inflightTools.delete(cid);
        break;
      }
      case 'approval/asked':
        if (d.id) pendingApproval.set(d.id, { ts: t, toolName: d.toolName || '', reason: d.reason || '' });
        break;
      case 'approval/decided':
        if (d.id) pendingApproval.delete(d.id);
        break;
      case 'user/message':
        if (!firstUserText) firstUserText = extractUserText(d);
        break;
      default:
        break;
    }
  }

  // 最近一个在途工具（仅在回合未闭合时有意义）
  let inflightToolTs = 0;
  let inflightToolName = '';
  if (openTurn) {
    for (const it of inflightTools.values()) {
      if (it.ts >= inflightToolTs) {
        inflightToolTs = it.ts;
        inflightToolName = it.name;
      }
    }
  }
  // 最近一个未决授权（仅回合未闭合时才视为「等你授权」）
  let openApproval = null;
  if (openTurn && pendingApproval.size > 0) {
    for (const a of pendingApproval.values()) {
      if (!openApproval || a.ts >= openApproval.ts) openApproval = a;
    }
  }

  return {
    openTurn,
    curTurnStartTs,
    lastEndReason,
    lastEndTs,
    lastTurnDurationMs,
    lastEventTs,
    firstUserText,
    inflightToolTs,
    inflightToolName,
    openApproval,
    recentEventTs:
      recentEventTs.length > ACTIVITY_MAX_TS ? recentEventTs.slice(-ACTIVITY_MAX_TS) : recentEventTs,
  };
}

/** 从 tool/result.data 提取其对应的 callId（多处兜底：source.callId → content[].toolCallId → callId）。 */
function resultCallId(d) {
  try {
    const m = d.message;
    if (m && m.source && m.source.callId) return m.source.callId;
    if (m && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.toolCallId) return c.toolCallId;
      }
    }
  } catch {
    /* ignore */
  }
  return d.callId || '';
}

/** 从 user/message.data 提取纯文本（content:[{type:'text',text}]）。 */
function extractUserText(d) {
  try {
    if (Array.isArray(d.content)) {
      const txt = d.content
        .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
        .map((c) => c.text || '')
        .join(' ')
        .trim();
      return txt;
    }
    if (typeof d.text === 'string') return d.text.trim();
  } catch {
    /* ignore */
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 状态判定（对标 watcher.decideState；产出同形状字段）
 * ------------------------------------------------------------------ */
/**
 * @param {object} sig parseDshEvents 的结果（事件流可用时）；不可用时传 null 走投影降级
 * @param {object} fallback 投影缓存降级信号 { openTurn, failure } —— 仅 sig=null 时使用
 */
function decideDshState(sig, fallback, mtimeMs, now, opts) {
  const stuckMs = (opts && opts.stuckMs) || DEFAULTS.stuckMs;
  const toolStuckMs = (opts && opts.toolStuckMs) || DEFAULTS.toolStuckMs;
  const stuckDetection = !(opts && opts.stuckDetection === false);
  const serverAlive = opts ? opts.dshServerAlive : undefined;

  let state;
  let stopReason = '';
  let question = '';
  let elapsedMs = 0;
  let turnDurationMs = 0;
  let runningTool = '';
  let activity = [];

  // 事件流可用（主路径）
  if (sig) {
    const lastActivityMs = Math.max(mtimeMs, sig.lastEventTs);
    const idleFor = now - lastActivityMs;
    const hasInflightTool = !!sig.inflightToolName || sig.inflightToolTs > 0;
    const effectiveStuckMs = hasInflightTool ? toolStuckMs : stuckMs;

    if (sig.openTurn) {
      if (sig.openApproval) {
        state = STATE.WAITING;
        question = approvalQuestion(sig.openApproval);
        elapsedMs = now - (sig.openApproval.ts || sig.curTurnStartTs || now);
      } else if (idleFor > effectiveStuckMs) {
        state = STATE.STUCK;
        elapsedMs = sig.curTurnStartTs ? now - sig.curTurnStartTs : 0;
      } else {
        state = STATE.RUNNING;
        elapsedMs = sig.curTurnStartTs ? now - sig.curTurnStartTs : 0;
      }
      if (hasInflightTool && (state === STATE.RUNNING || state === STATE.STUCK)) {
        runningTool = sig.inflightToolName || 'tool';
      }
    } else if (sig.lastEndReason) {
      stopReason = sig.lastEndReason;
      turnDurationMs = sig.lastTurnDurationMs || 0;
      elapsedMs = turnDurationMs;
      if (FAIL_KINDS.has(sig.lastEndReason)) state = STATE.FAILED;
      else if (CANCEL_KINDS.has(sig.lastEndReason)) state = STATE.CANCELLED;
      else state = STATE.DONE; // completed / 其它
    } else {
      state = STATE.IDLE; // 有事件但无 turn 生命周期
    }

    activity = buildActivity(sig.recentEventTs, now);
    return finalize({
      state, stopReason, question, elapsedMs, turnDurationMs, runningTool, activity,
      lastActivityMs, idleFor, serverAlive, stuckDetection,
    });
  }

  // 事件流不可用 → 投影缓存降级（openTurn / failure），仅能判运行中/完成/出错/中断
  const lastActivityMs = mtimeMs;
  const idleFor = now - lastActivityMs;
  const fb = fallback || {};
  if (fb.failure) {
    state = STATE.FAILED;
  } else if (fb.openTurn) {
    state = idleFor > stuckMs ? STATE.STUCK : STATE.RUNNING;
  } else {
    state = STATE.DONE;
  }
  return finalize({
    state, stopReason: '', question: '', elapsedMs: 0, turnDurationMs: 0, runningTool: '',
    activity: [], lastActivityMs, idleFor, serverAlive, stuckDetection,
  });
}

/** 授权提问文案：优先用 reason，其次「需要授权: 工具名」。 */
function approvalQuestion(a) {
  const r = (a.reason || '').replace(/\s+/g, ' ').trim();
  if (r) return r.slice(0, 140);
  return a.toolName ? `需要授权: ${a.toolName}` : '等待你授权';
}

/** 收敛：套用「确定性中断」与「关闭卡死兜底则降级」，产出 derived 字段。 */
function finalize(o) {
  let { state } = o;
  let interrupted = false;

  // 确定性中断：确知 dsh web 服务已不在运行，却判为运行中/卡住 → 标记「已中断」
  if (o.serverAlive === false && (state === STATE.RUNNING || state === STATE.STUCK)) {
    state = STATE.STUCK;
    interrupted = true;
  }
  // 关闭卡死兜底：把「疑似卡住」降级为「运行中」；但确定性中断不降级
  if (state === STATE.STUCK && !o.stuckDetection && !interrupted) state = STATE.RUNNING;

  return {
    state,
    stopReason: o.stopReason,
    question: o.question,
    interrupted,
    activity: o.activity,
    elapsedMs: o.elapsedMs,
    idleMs: o.idleFor,
    runningTool: o.runningTool,
    lastActivityMs: o.lastActivityMs,
    turnDurationMs: o.turnDurationMs,
  };
}

/* ------------------------------------------------------------------ *
 * 元数据：per-session 投影缓存（cwd/title/降级信号）+ workspace.json（path/title/archived）
 * ------------------------------------------------------------------ */
const _projByMtime = new Map(); // sessionId → { mtime, meta }
let _wsCache = { mtime: 0, byId: new Map(), archived: new Set() };

/** 读取单会话 per-session 投影（按 mtime 缓存）。返回 { cwd, title, openTurn, failure } 或 null。 */
function readProjection(sessionId) {
  const f = path.join(PROJCACHE_SESSIONS_DIR, sessionId + '.json');
  let st;
  try {
    st = fs.statSync(f);
  } catch {
    return null;
  }
  const cached = _projByMtime.get(sessionId);
  if (cached && cached.mtime === st.mtimeMs) return cached.meta;
  let meta = null;
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rec = d && d.record ? d.record : d; // 容错：兼容有/无 record 包裹
    const rows = (rec && rec.rows) || {};
    const rowVal = (k) => (rows[k] && typeof rows[k] === 'object' ? rows[k].val : undefined);
    const tb = rowVal('turnBoundary') || {};
    const goal = rowVal('goal') || {};
    meta = {
      cwd: (rec && rec.identity && rec.identity.cwd) || '',
      title: rowVal('title') || '',
      openTurn: tb && tb.openTurnStartSeq != null,
      failure: !!(goal && goal.failure),
    };
  } catch {
    meta = null;
  }
  _projByMtime.set(sessionId, { mtime: st.mtimeMs, meta });
  return meta;
}

/** 读取 workspace.json（按 mtime 缓存）：sessionId→{path,title} 映射 + archived 集合。 */
function readWorkspaces() {
  let st;
  try {
    st = fs.statSync(WORKSPACE_FILE);
  } catch {
    return _wsCache; // 读不到就用上次（或空）
  }
  if (_wsCache.mtime === st.mtimeMs) return _wsCache;
  const byId = new Map();
  const archived = new Set();
  try {
    const d = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'));
    const tabs = (d && d.tables && d.tables.workspaces) || {};
    for (const w of Object.values(tabs)) {
      if (!w || !Array.isArray(w.sessionIds)) continue;
      for (const sid of w.sessionIds) byId.set(sid, { path: w.path || '', title: w.title || '' });
    }
    for (const sid of (d && d.global && d.global.archivedSessionIds) || []) archived.add(sid);
  } catch {
    /* 保留上次 */
    return _wsCache;
  }
  _wsCache = { mtime: st.mtimeMs, byId, archived };
  return _wsCache;
}

/* ------------------------------------------------------------------ *
 * 枚举会话目录
 * ------------------------------------------------------------------ */
/** 列出所有 sessions/<编码cwd>/session-<id>/session.jsonl.zstd。返回 [{ id, zstd, mtimeMs, size }]。 */
function listDshSessions() {
  const out = [];
  let wsDirs;
  try {
    wsDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return out; // ~/.dsh/sessions 不存在（没装 dsh / 没跑过）→ 空
  }
  for (const wd of wsDirs) {
    if (!wd.isDirectory()) continue;
    const wsPath = path.join(SESSIONS_DIR, wd.name);
    let sessDirs;
    try {
      sessDirs = fs.readdirSync(wsPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sd of sessDirs) {
      if (!sd.isDirectory() || !sd.name.startsWith('session-')) continue;
      const zstd = path.join(wsPath, sd.name, 'session.jsonl.zstd');
      let stt;
      try {
        stt = fs.statSync(zstd);
      } catch {
        continue; // 没有事件文件，跳过
      }
      out.push({ id: sd.name, zstd, mtimeMs: stt.mtimeMs, size: stt.size });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 扫描全部 dsh 会话
 * ------------------------------------------------------------------ */
// 事件流解析缓存：zstd 路径 → { mtime, size, sig }（mtime+size 未变则复用，跳过解压+解析）
const _sigCache = new Map();
// 「进行时」会话：agent 仍活着（运行中 / 等你授权）。archived（用户在 dsh 里归档，相当于关闭 tab、
// 视为已处理）后仅当仍处于进行时才显示，其余（完成/出错/卡住/取消/空闲）一律隐藏，避免旧会话堆积。
const LIVE_STATES = new Set([STATE.RUNNING, STATE.WAITING]);

/**
 * 扫描 dsh 会话，返回与 Kiro/Claude 同形状的数组。
 * @param {object} opts { now, activeWithinMs, stuckMs, toolStuckMs, stuckDetection, dshServerAlive }
 *   dshServerAlive 可由主进程定时刷新后传入（避免每轮 pgrep）；不传则同步探测。
 */
function scanDshSessions(opts = {}) {
  const now = opts.now || Date.now();
  const activeWithinMs = opts.activeWithinMs ?? DEFAULTS.activeWithinMs;
  const stuckMs = opts.stuckMs ?? DEFAULTS.stuckMs;
  const toolStuckMs = opts.toolStuckMs ?? DEFAULTS.toolStuckMs;
  const stuckDetection = opts.stuckDetection !== false;
  const serverAlive =
    opts.dshServerAlive !== undefined ? opts.dshServerAlive : getDshServerAliveSync();

  const sessions = listDshSessions();
  if (!sessions.length) return [];

  const ws = readWorkspaces();
  const seen = new Set();
  const out = [];

  for (const s of sessions) {
    // 时间粗过滤：非活跃且超出窗口的直接跳过（运行中会话文件 mtime 必然新鲜，不会被误滤）
    if (activeWithinMs > 0 && now - s.mtimeMs > activeWithinMs) continue;

    // 事件流解析（按 mtime+size 缓存）
    let sig = null;
    const cached = _sigCache.get(s.zstd);
    if (cached && cached.mtime === s.mtimeMs && cached.size === s.size) {
      sig = cached.sig;
    } else {
      try {
        const buf = fs.readFileSync(s.zstd);
        const text = decompressSession(buf);
        sig = parseDshEvents(text);
      } catch {
        sig = null; // 解压/解析失败 → 走投影降级
      }
      _sigCache.set(s.zstd, { mtime: s.mtimeMs, size: s.size, sig });
    }
    seen.add(s.zstd);

    // 元数据 + 降级信号
    const proj = readProjection(s.id);
    const wsEntry = ws.byId.get(s.id);
    const cwd = (proj && proj.cwd) || (wsEntry && wsEntry.path) || '';
    const title =
      (proj && proj.title) ||
      (sig && sig.firstUserText) ||
      (wsEntry && wsEntry.title) ||
      s.id;

    const derived = decideDshState(
      sig,
      proj ? { openTurn: proj.openTurn, failure: proj.failure } : null,
      s.mtimeMs,
      now,
      { stuckMs, toolStuckMs, stuckDetection, dshServerAlive: serverAlive }
    );

    // archived（用户在 dsh 里归档，相当于关闭 tab）→ 除非仍在进行时（running/waiting），否则隐藏
    if (ws.archived.has(s.id) && !LIVE_STATES.has(derived.state)) continue;

    // 二级时间过滤：运行中始终显示，其余按最近活动时间筛掉老会话（与 Kiro/Claude 一致）
    if (
      derived.state !== STATE.RUNNING &&
      activeWithinMs > 0 &&
      now - derived.lastActivityMs > activeWithinMs
    ) {
      continue;
    }

    out.push({
      key: 'dsh:' + s.id,
      id: s.id,
      source: 'dsh',
      title: String(title).replace(/\s+/g, ' ').trim().slice(0, 160) || s.id,
      workspacePath: cwd,
      workspaceName: cwd ? path.basename(cwd) : '',
      rawStatus: sig ? '' : 'projcache', // 标注是否走了降级（诊断用）
      ...derived,
      isFocused: false, // dsh 无窗口/聚焦概念
      windowOpen: serverAlive === true, // 服务存活视为「打开」
    });
  }

  // 清理缓存里本轮未再出现的会话
  if (_sigCache.size > seen.size) {
    for (const k of _sigCache.keys()) if (!seen.has(k)) _sigCache.delete(k);
  }

  return out;
}

module.exports = {
  scanDshSessions,
  getDshServerAliveSync,
  getDshServerAliveAsync,
  DSH_HOME,
  // 便于测试
  parseDshEvents,
  decideDshState,
  decompressSession,
};

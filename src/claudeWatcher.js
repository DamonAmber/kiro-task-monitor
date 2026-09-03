'use strict';

/**
 * Claude Code 会话的**只读**监控。仅产出经过实测验证、能做准的信号：
 *   - 运行中：`~/.claude/sessions/<pid>.json` 的 status === 'busy'（实测生成期间稳定为 busy）
 *   - 完成/轮到你：进程存活 + status === 'idle'（idle 即本回合结束、等你下一步）
 *   - 失败：transcript 末行 assistant 带 isApiErrorMessage / error
 *   - 中断：进程已消失（pid 不在 `pgrep -x claude` 集合里）且此前在运行 → 确定性中断
 *
 * 数据来源（全部只读，绝不写入）：
 *   - ~/.claude/sessions/<pid>.json  { pid, sessionId, cwd, name, status, statusUpdatedAt, updatedAt, procStart }
 *   - ~/.claude/projects/<enc-cwd>/<sessionId>.jsonl  会话事件流（只 tail 末尾，取最后一条 user/assistant）
 *   - pgrep -x claude                进程存活（兼作 pid 复用防护：复用给非 claude 进程不会命中）
 *
 * 刻意**不做**（做不准/不可靠）：一键重试、聚焦终端、区分「等你授权」（终端 TUI 不落盘）。
 * 产出对象与 watcher.js 的 Kiro 会话同形状（多一个 source:'claude'），可被 UI / 通知统一处理。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { STATE, tailJsonLines } = require('./watcher');

const HOME = os.homedir();
const CC_SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const CC_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const TAIL_BYTES = 96 * 1024; // 取 transcript 末尾，够拿到最后一条 user/assistant

/* ------------------------------------------------------------------ *
 * 进程存活（pid 复用防护：pgrep -x 只匹配进程名恰为 "claude" 的会话进程）
 * ------------------------------------------------------------------ */
function parsePids(out) {
  return new Set(
    String(out || '')
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
}

/** 同步取当前所有 claude 会话进程 pid。返回 Set；pgrep 缺失返回 null（未知→不判中断，安全）。 */
function getClaudePidsSync() {
  try {
    return parsePids(execFileSync('pgrep', ['-x', 'claude'], { encoding: 'utf8', timeout: 2000 }));
  } catch (e) {
    if (e && e.status === 1) return new Set(); // 正常执行、零匹配
    return null; // pgrep 缺失/异常 → 未知
  }
}

/** 异步版本（供主进程定时刷新，不阻塞）。 */
function getClaudePidsAsync() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', 'claude'], { encoding: 'utf8', timeout: 2000 }, (err, stdout) => {
      if (!err) return resolve(parsePids(stdout));
      if (err.code === 1) return resolve(new Set());
      resolve(null);
    });
  });
}

/* ------------------------------------------------------------------ *
 * transcript 定位 + 末行解析（按 mtime 缓存）
 * ------------------------------------------------------------------ */
const _pathBySession = new Map(); // sessionId → transcript 路径（找到后缓存，路径不变）
const _tailCache = new Map(); // 路径 → { mtime, size, parsed }

/** 在 ~/.claude/projects/ 各项目目录下查找 <sessionId>.jsonl（cwd 编码含非 ASCII 不可靠，故直接按文件名找）。 */
function findTranscript(sessionId) {
  const cached = _pathBySession.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  let dirs;
  try {
    dirs = fs.readdirSync(CC_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(CC_PROJECTS_DIR, d.name, sessionId + '.jsonl');
    if (fs.existsSync(f)) {
      _pathBySession.set(sessionId, f);
      return f;
    }
  }
  return null;
}

/** 解析 tail 出的事件，取最后一条 user/assistant 的关键信号 + 最近一轮耗时。 */
function parseTail(lines) {
  let lastType = null; // 'user' | 'assistant'
  let lastStop = null;
  let lastErr = false;
  let lastTs = 0;
  let curUserTs = 0;
  let lastTurnDur = 0;
  for (const o of lines) {
    const t = o && o.type;
    if (!t) continue;
    const tsv = Date.parse(o.timestamp) || 0;
    if (tsv > lastTs) lastTs = tsv;
    if (t === 'user') {
      curUserTs = tsv;
      lastType = 'user';
      lastStop = null;
      lastErr = false;
    } else if (t === 'assistant') {
      const m = o.message && typeof o.message === 'object' ? o.message : {};
      lastType = 'assistant';
      lastStop = m.stop_reason || null;
      lastErr = !!o.isApiErrorMessage || !!o.error;
      if (curUserTs && tsv >= curUserTs) lastTurnDur = tsv - curUserTs;
    }
  }
  return { lastType, lastStop, lastErr, lastTs, lastTurnDur };
}

/** 读取某会话 transcript 末行信号（按 mtime+size 缓存）。无 transcript 返回 null。 */
function readTail(sessionId) {
  const f = findTranscript(sessionId);
  if (!f) return null;
  let st;
  try {
    st = fs.statSync(f);
  } catch {
    return null;
  }
  const cached = _tailCache.get(f);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
    return { ...cached.parsed, mtimeMs: st.mtimeMs };
  }
  const { lines } = tailJsonLines(f, TAIL_BYTES);
  const parsed = parseTail(lines);
  _tailCache.set(f, { mtime: st.mtimeMs, size: st.size, parsed });
  return { ...parsed, mtimeMs: st.mtimeMs };
}

/* ------------------------------------------------------------------ *
 * 扫描 Claude Code 会话
 * ------------------------------------------------------------------ */
const DEFAULT_ACTIVE_MS = 24 * 60 * 60 * 1000;

/** 读取并解析 sessions/<pid>.json 列表。 */
function readSessionRegistry() {
  let files;
  try {
    files = fs.readdirSync(CC_SESSIONS_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(CC_SESSIONS_DIR, n), 'utf8'));
      if (d && d.pid && d.sessionId) out.push(d);
    } catch {
      /* 跳过损坏项 */
    }
  }
  return out;
}

/**
 * 扫描 Claude Code 会话，返回与 Kiro 会话同形状的数组。
 * @param {object} opts { now, activeWithinMs, claudePids?:Set|null }
 *   claudePids 可由主进程定时刷新后传入（避免每轮 pgrep）；不传则同步 pgrep。
 */
function scanClaudeSessions(opts = {}) {
  const now = opts.now || Date.now();
  const activeWithinMs = opts.activeWithinMs ?? DEFAULT_ACTIVE_MS;
  const pids = opts.claudePids !== undefined ? opts.claudePids : getClaudePidsSync();

  const regs = readSessionRegistry();
  const out = [];

  for (const d of regs) {
    const pid = d.pid;
    // 存活：pids 未知(null)时保守视为存活（不误判中断）
    const live = pids ? pids.has(pid) : true;
    const status = d.status || '';
    const statusUpdatedAt = Number(d.statusUpdatedAt) || 0;
    const updatedAt = Number(d.updatedAt) || 0;
    const cwd = d.cwd || '';

    let state;
    let interrupted = false;
    let elapsedMs = 0;
    let turnDurationMs = 0;
    let lastActivityMs = updatedAt;

    if (live && status === 'busy') {
      // 运行中（实测：生成期间 status 稳定为 busy）
      state = STATE.RUNNING;
      elapsedMs = statusUpdatedAt ? now - statusUpdatedAt : 0; // 从进入 busy 起算
      lastActivityMs = now;
    } else {
      // 需要 transcript 判断失败/中断，并取更精确的活动时间
      const tail = readTail(d.sessionId);
      if (tail) {
        lastActivityMs = Math.max(lastActivityMs, tail.mtimeMs || 0, tail.lastTs || 0);
        turnDurationMs = tail.lastTurnDur || 0;
      }
      if (!live) {
        // 进程已消失：若此前在运行（status busy 冻结，或末行是 user/工具结果=回合未完）→ 确定性中断
        const midRun = status === 'busy' || (tail && tail.lastType === 'user');
        if (!midRun) continue; // 正常结束后关闭的会话 → 不显示（等同 Kiro 的残留过滤）
        state = STATE.STUCK;
        interrupted = true;
      } else if (tail && tail.lastErr) {
        state = STATE.FAILED;
      } else {
        // 存活 + idle：本回合结束，轮到你
        state = STATE.DONE;
      }
    }

    // 时间过滤：运行中始终显示；其余按最近活动时间筛掉老会话（与 Kiro 一致）
    if (state !== STATE.RUNNING && activeWithinMs > 0 && now - lastActivityMs > activeWithinMs) {
      continue;
    }

    out.push({
      key: 'cc:' + d.sessionId,
      id: d.sessionId,
      source: 'claude',
      title: d.name || d.sessionId,
      workspacePath: cwd,
      workspaceName: cwd ? path.basename(cwd) : '',
      rawStatus: status,
      state,
      interrupted,
      stopReason: '',
      question: '',
      runningTool: '',
      activity: [], // Claude 无事件密度时间线（终端 transcript 不逐事件落盘）
      elapsedMs,
      idleMs: now - lastActivityMs,
      turnDurationMs,
      lastActivityMs,
      isFocused: false, // Claude 无窗口/聚焦概念
      windowOpen: live,
    });
  }

  return out;
}

module.exports = {
  scanClaudeSessions,
  getClaudePidsSync,
  getClaudePidsAsync,
  // 便于测试
  parseTail,
  readSessionRegistry,
};

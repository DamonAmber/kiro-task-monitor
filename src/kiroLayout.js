'use strict';

/**
 * Kiro 本地目录布局的发现与探测。
 *
 * 背景：会话文件默认在 `~/.kiro/sessions/<workspaceHash>/<sessionId>/{session.json,messages.jsonl}`。
 * 但不同 Kiro 版本可能把会话挪到 `~/.kiro` 下别的子目录（用户实测出现过 `~/.kiro/sessions` 整个不存在
 * 却在跑 Kiro 的情况）。为不再被写死路径卡住：
 *   - findSessionDirs()：默认路径拿不到时，在 `~/.kiro` 下**有界**搜索任何含 `session.json` 的目录，
 *     自动适配「会话被挪到 .kiro 下其它位置」的布局（附加能力，只在需要时用）。
 *   - inspectKiroDir() / summarizeSessionIndex() / probeGlobalStorageEntries()：供诊断报告如实呈现
 *     用户机器的真实布局，即便自动发现没命中，也能一眼看出会话到底在哪。
 *
 * 全程只读、绝不抛错；搜索跳过明显无关的重目录并设访问上限，避免拖慢。
 */

const fs = require('fs');
const path = require('path');
const { KIRO_DIR, SESSIONS_DIR, GLOBAL_STORAGE_DIR } = require('./kiroPaths');

// 搜索时跳过的无关/重目录（不会含会话，且可能很大）。
const SKIP_DIRS = new Set([
  'logs',
  'cache',
  'Cache',
  'extensions',
  'CachedData',
  'CachedExtensionVSIXs',
  'node_modules',
  '.git',
  'snapshots', // 会话内的快照目录，量大且不含 session.json
  'globalStorage',
  'workspaceStorage',
]);

/**
 * 在 `~/.kiro` 下有界搜索含 `session.json` 的目录（每个即一个会话目录）。
 * @returns {string[]} 绝对路径数组
 */
function searchSessionDirs(baseDir, { maxDepth = 5, cap = 30000 } = {}) {
  const found = [];
  let visited = 0;
  const stack = [{ dir: baseDir, depth: 0 }];
  while (stack.length) {
    if (visited > cap) break;
    const { dir, depth } = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // 该目录本身就是一个会话目录？
    if (entries.some((e) => e.isFile() && e.name === 'session.json')) {
      found.push(dir);
      continue; // 会话目录内部不必再深入
    }
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  return found;
}

// 发现结果缓存：会话很多时避免每轮轮询都重新走一遍文件树。
let _cache = { at: 0, dirs: [] };
const DISCOVER_TTL_MS = 15000;

/**
 * 发现会话目录（用于「默认路径拿不到会话」时的回退）。带 15s TTL 缓存。
 * @returns {string[]} 含 session.json 的绝对目录数组
 */
function findSessionDirs(opts = {}) {
  const now = Date.now();
  if (!opts.force && now - _cache.at < DISCOVER_TTL_MS) return _cache.dirs;
  let dirs = [];
  try {
    dirs = searchSessionDirs(KIRO_DIR, opts);
  } catch {
    dirs = [];
  }
  _cache = { at: now, dirs };
  return dirs;
}

/** 列出 `~/.kiro` 顶层条目（仅名称+类型，供诊断呈现真实布局）。失败返回 null。 */
function inspectKiroDir() {
  let entries;
  try {
    entries = fs.readdirSync(KIRO_DIR, { withFileTypes: true });
  } catch (e) {
    return { exists: false, error: (e && e.code) || 'READ_ERROR', entries: [] };
  }
  return {
    exists: true,
    entries: entries.slice(0, 60).map((e) => ({ name: e.name, dir: e.isDirectory() })),
  };
}

/**
 * 汇总 `~/.kiro/session-index`（新版索引：<workspaceHash>.jsonl，每行 {op,sessionPath,at}）。
 * 顺带判断索引里引用的第一个 sessionPath 是否能在 `~/.kiro/sessions` 下解析到——
 * 若索引存在但引用解析不到，说明会话内容目录被挪走/删除（重要线索）。
 */
function summarizeSessionIndex() {
  const dir = path.join(KIRO_DIR, 'session-index');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { exists: false };
  }
  let referenced = 0;
  let firstPath = '';
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s);
        if (rec && rec.op === 'add' && rec.sessionPath) {
          referenced += 1;
          if (!firstPath) firstPath = rec.sessionPath;
        }
      } catch {
        /* 忽略坏行 */
      }
    }
  }
  let firstResolvesUnderSessions = null;
  if (firstPath) {
    try {
      firstResolvesUnderSessions = fs.existsSync(path.join(SESSIONS_DIR, firstPath));
    } catch {
      firstResolvesUnderSessions = null;
    }
  }
  return { exists: true, jsonlCount: files.length, referencedCount: referenced, firstResolvesUnderSessions };
}

/** 列出 Kiro globalStorage 顶层条目名（探测会话是否被放进了 Application Support 一侧）。 */
function probeGlobalStorageEntries() {
  try {
    return fs.readdirSync(GLOBAL_STORAGE_DIR).slice(0, 60);
  } catch {
    return null;
  }
}

module.exports = {
  findSessionDirs,
  searchSessionDirs,
  inspectKiroDir,
  summarizeSessionIndex,
  probeGlobalStorageEntries,
};

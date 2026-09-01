'use strict';

/**
 * 读取「当前真正打开的 Kiro 窗口 + 每个窗口打开/聚焦了哪个会话」。
 *
 * 目的：Kiro 会在 ~/.kiro/sessions 里留下大量历史会话文件，仅凭文件最近修改时间
 * 无法区分「窗口里真正打开着的会话」和「昨天用过、现在早已关闭的残留会话」。
 * 这里通过 Kiro 应用（VS Code 内核）的本地状态，拿到权威信号：
 *   - storage.json → windowsState.openedWindows[]：当前打开的窗口（工作区文件夹）
 *                    windowsState.lastActiveWindow.folder：最近激活的窗口
 *   - 每个窗口 workspaceStorage/<hash>/state.vscdb 中 kiro.kiroAgent 键：
 *       · sessionPanels.entries[] → 该窗口侧边栏里打开的会话（id / title）
 *       · sessionPanels.focused   → 该窗口当前聚焦（激活）的会话 id
 *
 * 全程**只读**，且任何一步失败都安全降级（返回 ok:false / readable:false），
 * 由调用方决定是否回退到「按活动时间显示全部」的旧行为，绝不因此让监控变空白。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  GLOBAL_STORAGE_JSON,
  WORKSPACE_STORAGE_DIR,
} = require('./kiroPaths');

/** 把 `file:///Users/...` 或普通路径统一成去尾斜杠的本地路径，便于与 workspacePath 比对。 */
function normFolder(uriOrPath) {
  if (!uriOrPath || typeof uriOrPath !== 'string') return '';
  let s = uriOrPath;
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length);
    try {
      s = decodeURIComponent(s);
    } catch {
      /* 保留原样 */
    }
  }
  return s.replace(/\/+$/, '');
}

/** 从 storage.json 解析当前打开的窗口文件夹集合与最近激活窗口。 */
function readOpenedWindows() {
  let raw;
  try {
    raw = fs.readFileSync(GLOBAL_STORAGE_JSON, 'utf8');
  } catch {
    return null; // 文件不存在 → 无法判断，交由调用方降级
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const ws = data && data.windowsState;
  if (!ws || typeof ws !== 'object') return null;

  const openFolders = new Set();
  const opened = Array.isArray(ws.openedWindows) ? ws.openedWindows : [];
  for (const w of opened) {
    // 只处理单文件夹窗口（folder）；多根工作区（workspace.configPath）暂不支持
    const f = normFolder(w && w.folder);
    if (f) openFolders.add(f);
  }
  const activeFolder = normFolder(ws.lastActiveWindow && ws.lastActiveWindow.folder);
  return { openFolders, activeFolder };
}

/** 建立 工作区文件夹 → state.vscdb 路径 的映射（扫描 workspaceStorage 下各 workspace.json）。 */
function readWorkspaceDbMap() {
  const map = new Map();
  let dirs;
  try {
    dirs = fs.readdirSync(WORKSPACE_STORAGE_DIR, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const base = path.join(WORKSPACE_STORAGE_DIR, d.name);
    let folder = '';
    try {
      const wj = JSON.parse(fs.readFileSync(path.join(base, 'workspace.json'), 'utf8'));
      folder = normFolder(wj && wj.folder);
    } catch {
      continue;
    }
    if (folder) map.set(folder, path.join(base, 'state.vscdb'));
  }
  return map;
}

/**
 * 从某个窗口的 state.vscdb 读取 sessionPanels。
 * 返回 { readable, ids:Set, focused, titles:Map }：
 *   - readable:false 表示读取失败或键尚不存在（未知）→ 调用方应保守保留该窗口的会话；
 *   - readable:true + 空 ids 表示该窗口确实没有打开任何会话面板。
 */
function readPanels(dbPath) {
  const unknown = { readable: false, ids: new Set(), focused: null, titles: new Map() };
  let out;
  try {
    out = execFileSync(
      'sqlite3',
      ['-readonly', dbPath, "SELECT value FROM ItemTable WHERE key='kiro.kiroAgent';"],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch {
    return unknown; // sqlite3 缺失 / DB 锁 / 读取异常 → 未知
  }
  const text = (out || '').trim();
  if (!text) return unknown; // 该键尚不存在（窗口刚打开、还没跑过 agent）→ 未知

  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return unknown;
  }
  const entries = Array.isArray(j['sessionPanels.entries']) ? j['sessionPanels.entries'] : [];
  const ids = new Set();
  const titles = new Map();
  for (const e of entries) {
    if (e && e.id) {
      ids.add(e.id);
      if (e.title) titles.set(e.id, e.title);
    }
  }
  const focused = j['sessionPanels.focused'] || null;
  return { readable: true, ids, focused, titles };
}

/**
 * 汇总当前打开窗口及其会话面板上下文。
 * @returns {{
 *   ok: boolean,                       // 是否成功解析到窗口状态（false 时调用方应降级为不过滤）
 *   openFolders: Set<string>,          // 当前打开的工作区文件夹
 *   activeFolder: string|null,         // 最近激活的窗口文件夹
 *   panelsByFolder: Map<string, {readable, ids:Set, focused, titles:Map}>,
 *   openSessionIds: Set<string>,       // 所有打开窗口里打开的会话 id（仅 readable 窗口）
 *   focusedSessionIds: Set<string>,    // 所有打开窗口里聚焦的会话 id
 * }}
 */
function readOpenWindowContext() {
  const empty = {
    ok: false,
    openFolders: new Set(),
    activeFolder: null,
    panelsByFolder: new Map(),
    openSessionIds: new Set(),
    focusedSessionIds: new Set(),
  };

  const win = readOpenedWindows();
  if (!win) return empty;

  const dbMap = readWorkspaceDbMap();
  const panelsByFolder = new Map();
  const openSessionIds = new Set();
  const focusedSessionIds = new Set();

  for (const folder of win.openFolders) {
    const db = dbMap.get(folder);
    if (!db) {
      panelsByFolder.set(folder, { readable: false, ids: new Set(), focused: null, titles: new Map() });
      continue;
    }
    const panels = readPanels(db);
    panelsByFolder.set(folder, panels);
    if (panels.readable) {
      for (const id of panels.ids) openSessionIds.add(id);
      if (panels.focused) focusedSessionIds.add(panels.focused);
    }
  }

  return {
    ok: true,
    openFolders: win.openFolders,
    activeFolder: win.activeFolder || null,
    panelsByFolder,
    openSessionIds,
    focusedSessionIds,
  };
}

module.exports = {
  readOpenWindowContext,
  normFolder,
  // 便于测试 / 复用
  readOpenedWindows,
  readWorkspaceDbMap,
  readPanels,
};

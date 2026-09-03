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
const { execFile, execFileSync } = require('child_process');
const {
  GLOBAL_STORAGE_JSON,
  WORKSPACE_STORAGE_DIR,
} = require('./kiroPaths');

// 用命令行匹配 Kiro 的进程（主进程 + 各 Helper 都在 Kiro.app/Contents/ 下）。
// 注意：
//   - 用 `Kiro\.app/Contents/`（转义点）而非更窄的 `.../MacOS/`：主进程实为
//     `Kiro.app/Contents/MacOS/Electron`，实测 macOS `pgrep -f` 匹配不到该 `/MacOS/` 段，
//     只有匹配 `Kiro.app/Contents/`（各 Helper 路径）才稳定命中——否则会误判 Kiro 未运行、
//     把运行中的会话错标成「已中断」（曾导致偶现误判）。
//   - 监控自身是「Kiro 任务监控.app」、以及「Kiro CLI.app」，其路径都不含子串 "Kiro.app"，不会误匹配。
const KIRO_PROC_PATTERN = 'Kiro\\.app/Contents/';

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

/**
 * 统计当前打开的窗口构成（诊断用）：区分单文件夹窗口、多根工作区（.code-workspace / configPath）、
 * 空窗口。多根工作区目前不参与「打开会话」匹配（本模块只处理 w.folder），是「会话识别不到」的
 * 已知盲区之一——这个统计能一眼看出用户是不是踩到了它。只读、失败返回 null。
 */
function inspectOpenedWindows() {
  let raw;
  try {
    raw = fs.readFileSync(GLOBAL_STORAGE_JSON, 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const ws = data && data.windowsState;
  if (!ws || typeof ws !== 'object') return null;
  const opened = Array.isArray(ws.openedWindows) ? ws.openedWindows : [];
  let folders = 0;
  let multiRoot = 0;
  let empty = 0;
  for (const w of opened) {
    if (w && w.folder) folders += 1;
    else if (w && w.workspace) multiRoot += 1; // { workspace: { id, configPath } } = 多根工作区
    else empty += 1;
  }
  return {
    total: opened.length,
    folders,
    multiRoot,
    empty,
    hasLastActive: !!(ws.lastActiveWindow && ws.lastActiveWindow.folder),
  };
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
const SQLITE_QUERY = "SELECT value FROM ItemTable WHERE key='kiro.kiroAgent';";

/** 解析 sqlite3 取出的 kiro.kiroAgent 值 → sessionPanels。空/异常返回 unknown。 */
function parsePanelsValue(text) {
  const unknown = { readable: false, ids: new Set(), focused: null, titles: new Map() };
  const s = (text || '').trim();
  if (!s) return unknown; // 该键尚不存在（窗口刚打开、还没跑过 agent）→ 未知
  let j;
  try {
    j = JSON.parse(s);
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
  return { readable: true, ids, focused: j['sessionPanels.focused'] || null, titles };
}

function readPanels(dbPath) {
  const unknown = { readable: false, ids: new Set(), focused: null, titles: new Map() };
  let out;
  try {
    out = execFileSync('sqlite3', ['-readonly', dbPath, SQLITE_QUERY], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return unknown; // sqlite3 缺失 / DB 锁 / 读取异常 → 未知
  }
  return parsePanelsValue(out);
}

/** readPanels 的异步版本（不阻塞主进程），供主进程定时刷新使用。 */
function readPanelsAsync(dbPath) {
  const unknown = { readable: false, ids: new Set(), focused: null, titles: new Map() };
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-readonly', dbPath, SQLITE_QUERY],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(unknown);
        resolve(parsePanelsValue(stdout));
      }
    );
  });
}

/**
 * Kiro 主进程是否在运行。返回 true / false / undefined：
 *   - true      pgrep 命中 Kiro.app 的可执行进程
 *   - false     pgrep 正常执行但零命中（exit 1）→ 确认 Kiro 未运行
 *   - undefined pgrep 缺失 / 异常 → 未知（调用方据此**不做**中断判定，保持安全）
 */
function isKiroRunningAsync() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', KIRO_PROC_PATTERN], { timeout: 2000 }, (err) => {
      if (!err) return resolve(true); // exit 0 → 有匹配
      if (err.code === 1) return resolve(false); // exit 1 → 确认无匹配
      resolve(undefined); // 其它（pgrep 缺失等）→ 未知
    });
  });
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

/**
 * readOpenWindowContext 的异步版本，额外返回 `kiroRunning`（Kiro 主进程是否在运行）。
 * 主进程用它在定时器 / 文件变更时刷新，**不阻塞**（sqlite / pgrep 全走异步 spawn）。
 * fs 读取（storage.json / workspace.json）本身很快，保持同步。
 */
async function readOpenWindowContextAsync() {
  const base = {
    ok: false,
    openFolders: new Set(),
    activeFolder: null,
    panelsByFolder: new Map(),
    openSessionIds: new Set(),
    focusedSessionIds: new Set(),
    kiroRunning: undefined,
  };

  const kiroRunning = await isKiroRunningAsync();
  const win = readOpenedWindows();
  if (!win) return { ...base, kiroRunning };

  const dbMap = readWorkspaceDbMap();
  const panelsByFolder = new Map();
  const openSessionIds = new Set();
  const focusedSessionIds = new Set();

  const folders = [...win.openFolders];
  const results = await Promise.all(
    folders.map(async (folder) => {
      const db = dbMap.get(folder);
      if (!db) return [folder, { readable: false, ids: new Set(), focused: null, titles: new Map() }];
      return [folder, await readPanelsAsync(db)];
    })
  );
  for (const [folder, panels] of results) {
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
    kiroRunning,
  };
}

module.exports = {
  readOpenWindowContext,
  readOpenWindowContextAsync,
  isKiroRunningAsync,
  normFolder,
  inspectOpenedWindows,
  // 便于测试 / 复用
  readOpenedWindows,
  readWorkspaceDbMap,
  readPanels,
  readPanelsAsync,
  parsePanelsValue,
};

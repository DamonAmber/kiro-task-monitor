'use strict';

const os = require('os');
const path = require('path');

/**
 * Kiro 会话数据的根目录。
 * 结构：~/.kiro/sessions/<workspaceHash>/<sessionId>/{session.json, messages.jsonl}
 */
const HOME = os.homedir();
const KIRO_DIR = path.join(HOME, '.kiro');
const SESSIONS_DIR = path.join(KIRO_DIR, 'sessions');

/**
 * Kiro 应用（基于 VS Code）的用户数据目录（macOS）。
 * 这里只做**只读**访问，用于判断哪些窗口/会话当前真正打开、哪个会话被聚焦。
 *   - storage.json 记录当前打开的窗口列表（windowsState.openedWindows）及最近激活窗口
 *   - workspaceStorage/<hash>/{workspace.json, state.vscdb}
 *     · workspace.json      → 该窗口对应的工作区文件夹
 *     · state.vscdb(SQLite) → kiro.kiroAgent 键内含 sessionPanels.entries / sessionPanels.focused
 */
const KIRO_APP_SUPPORT = path.join(HOME, 'Library', 'Application Support', 'Kiro');
const GLOBAL_STORAGE_DIR = path.join(KIRO_APP_SUPPORT, 'User', 'globalStorage');
const GLOBAL_STORAGE_JSON = path.join(GLOBAL_STORAGE_DIR, 'storage.json');
const WORKSPACE_STORAGE_DIR = path.join(KIRO_APP_SUPPORT, 'User', 'workspaceStorage');

/**
 * 全局状态库（SQLite）。ItemTable 里 key='kiro.kiroAgent' 的 value(JSON) 中，
 * 字段 kiro.resourceNotifications.usageState 缓存了当前账号的套餐用量快照
 * （usageLimit / currentUsage / currentOverages / resetDate 等）。仅**只读**访问。
 */
const GLOBAL_STATE_DB = path.join(GLOBAL_STORAGE_DIR, 'state.vscdb');

module.exports = {
  HOME,
  KIRO_DIR,
  SESSIONS_DIR,
  KIRO_APP_SUPPORT,
  GLOBAL_STORAGE_DIR,
  GLOBAL_STORAGE_JSON,
  WORKSPACE_STORAGE_DIR,
  GLOBAL_STATE_DB,
};

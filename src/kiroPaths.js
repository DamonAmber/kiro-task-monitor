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

module.exports = {
  HOME,
  KIRO_DIR,
  SESSIONS_DIR,
};

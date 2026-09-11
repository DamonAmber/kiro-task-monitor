'use strict';

/**
 * 独立验证工具：不依赖 Electron，直接扫描并打印每个会话的推导状态。
 * 覆盖三种来源：Kiro（~/.kiro）· Claude Code（~/.claude）· DeepSeek Harness（~/.dsh，dsh web）。
 * 每行行首字母标注来源：K=Kiro C=Claude D=dsh；★ 标记该 Kiro 窗口聚焦（激活）的会话。
 * 用法：
 *   node tools/watch-cli.js --once          # 扫描一次
 *   node tools/watch-cli.js                 # 每 2s 刷新
 *   node tools/watch-cli.js --all           # 放宽 24h 时间过滤
 *   node tools/watch-cli.js --all-sessions  # 关闭「只看已打开」，显示 Kiro 历史残留会话
 *   node tools/watch-cli.js --focused       # 每个窗口只看当前聚焦会话
 *   node tools/watch-cli.js --no-claude     # 不扫描 Claude Code 会话
 *   node tools/watch-cli.js --no-dsh        # 不扫描 dsh 会话
 */

const { scanSessions, compareSessions, STATE } = require('../src/watcher');
const { scanClaudeSessions } = require('../src/claudeWatcher');
const { scanDshSessions } = require('../src/dshWatcher');

const args = process.argv.slice(2);
const once = args.includes('--once');
const showAll = args.includes('--all');
const allSessions = args.includes('--all-sessions');
const focusedOnly = args.includes('--focused');
const noClaude = args.includes('--no-claude');
const noDsh = args.includes('--no-dsh');

// 来源标签（一眼区分 Kiro / Claude / dsh）
const SRC_TAG = {
  kiro: '\x1b[34mK\x1b[0m',
  claude: '\x1b[33mC\x1b[0m',
  dsh: '\x1b[35mD\x1b[0m',
};

const COLORS = {
  [STATE.RUNNING]: '\x1b[34m', // 蓝
  [STATE.WAITING]: '\x1b[33m', // 黄
  [STATE.DONE]: '\x1b[32m', // 绿
  [STATE.FAILED]: '\x1b[31m', // 红
  [STATE.STUCK]: '\x1b[35m', // 品红
  [STATE.CANCELLED]: '\x1b[90m', // 灰
  [STATE.IDLE]: '\x1b[90m',
};
const RESET = '\x1b[0m';

const LABEL = {
  [STATE.RUNNING]: '运行中 ',
  [STATE.WAITING]: '等待你 ',
  [STATE.DONE]: '已完成 ',
  [STATE.FAILED]: '出错❗ ',
  [STATE.STUCK]: '卡住❓ ',
  [STATE.CANCELLED]: '已取消 ',
  [STATE.IDLE]: '空闲   ',
};

function fmtDur(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function render() {
  const activeWithinMs = showAll ? 0 : undefined;
  const kiro = scanSessions({
    activeWithinMs,
    onlyOpenSessions: !allSessions,
    onlyFocusedSession: focusedOnly,
  });
  const claude = noClaude ? [] : safeScan(() => scanClaudeSessions({ activeWithinMs }), 'claude');
  const dsh = noDsh ? [] : safeScan(() => scanDshSessions({ activeWithinMs }), 'dsh');
  const sessions = [...kiro, ...claude, ...dsh].sort(compareSessions);

  const now = new Date().toLocaleTimeString();
  const mode = allSessions ? '全部(含残留)' : focusedOnly ? '仅聚焦' : '仅已打开';
  let out = `\n=== AI 会话监控  (${now})  [${mode}]  共 ${sessions.length} 个  (来源 \x1b[34mK\x1b[0miro/\x1b[33mC\x1b[0mlaude/\x1b[35mD\x1b[0msh) ===\n`;
  for (const s of sessions) {
    const c = COLORS[s.state] || '';
    const label = s.interrupted ? '中断❓ ' : LABEL[s.state] || s.state;
    const dur = fmtDur(s.elapsedMs);
    const ws = s.workspaceName || '-';
    const title = (s.title || '').replace(/\s+/g, ' ').slice(0, 42);
    const src = SRC_TAG[s.source] || '?';
    const focus = s.isFocused ? '\x1b[36m★\x1b[0m' : ' '; // 青色 ★ = 该窗口聚焦会话
    const extra =
      s.state === STATE.FAILED ? ` [stopReason=${s.stopReason}]`
      : (s.state === STATE.RUNNING || s.state === STATE.STUCK) && s.runningTool ? ` [tool: ${s.runningTool}]`
      : s.state === STATE.WAITING && s.question ? ` [问: ${s.question.slice(0, 40)}]`
      : '';
    out += `${focus}${src} ${c}● ${label}${RESET} ${dur.padStart(6)}  ${ws.padEnd(16)} ${title}${extra}\n`;
  }
  return out;
}

/** 扫描包裹：单个来源失败不影响整体（打印一行错误提示，返回空）。 */
function safeScan(fn, name) {
  try {
    return fn();
  } catch (e) {
    process.stderr.write(`[${name}] 扫描失败: ${(e && e.message) || e}\n`);
    return [];
  }
}

if (once) {
  process.stdout.write(render());
} else {
  const loop = () => {
    process.stdout.write('\x1b[2J\x1b[H'); // 清屏
    process.stdout.write(render());
  };
  loop();
  setInterval(loop, 2000);
}

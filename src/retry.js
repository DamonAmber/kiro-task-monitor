'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

const KIRO_BUNDLE_ID = 'dev.kiro.desktop';

/**
 * 解析 Kiro 命令行（VS Code 风格 CLI）的绝对路径。
 * 打包后的 app 环境变量 PATH 未必包含 /usr/local/bin，因此按候选路径探测。
 * 用 `kiro <工作区路径>` 聚焦已打开的对应窗口——由 Kiro 自己把窗口带到前台，
 * 能可靠跨 Space / 全屏（这是 AppleScript 的 AXRaise 做不到的）。
 */
let _kiroCliCache;
function resolveKiroCli() {
  if (_kiroCliCache !== undefined) return _kiroCliCache;
  const candidates = [
    '/usr/local/bin/kiro',
    '/opt/homebrew/bin/kiro',
    `${process.env.HOME || ''}/.local/bin/kiro`,
    '/Applications/Kiro.app/Contents/Resources/app/bin/kiro',
    '/Applications/Kiro.app/Contents/Resources/app/bin/code',
  ];
  _kiroCliCache = candidates.find((p) => {
    try {
      return p && fs.existsSync(p);
    } catch {
      return false;
    }
  }) || null;
  return _kiroCliCache;
}

/** 转义写入 AppleScript 字符串字面量的内容。 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function runOsascript(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        // -1743 / not allowed assistive access → 缺少「辅助功能」权限
        const needsPerm = /1743|not allowed|assistive|accessibility/i.test(msg);
        resolve({ ok: false, error: msg, needsPermission: needsPerm });
      } else {
        resolve({ ok: true, stdout: (stdout || '').trim() });
      }
    });
  });
}

/**
 * 用 Kiro CLI 聚焦某工作区的窗口（首选，跨 Space / 全屏可靠）。
 * 该工作区若已有打开的窗口，Kiro 会聚焦它并切到其所在的 Space。
 */
function focusViaCli(workspacePath) {
  return new Promise((resolve) => {
    const cli = resolveKiroCli();
    if (!cli || !workspacePath) {
      resolve({ ok: false, error: cli ? 'no-path' : 'no-cli' });
      return;
    }
    execFile(cli, [workspacePath], { timeout: 8000 }, (err, _stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message || '').trim() });
      else resolve({ ok: true, via: 'cli' });
    });
  });
}

/**
 * AppleScript 兜底：把标题包含 workspaceName 的 Kiro 窗口置前。
 * 注意：对处于原生全屏（独立 Space）的窗口，AXRaise 常常无法切换过去。
 */
function raiseWindowScript(workspaceName) {
  const name = esc(workspaceName);
  return `
tell application "System Events"
  if not (exists process "Kiro") then
    return "no-process"
  end if
  set kiro to first process whose bundle identifier is "${KIRO_BUNDLE_ID}"
  set frontmost of kiro to true
  set matched to false
  if "${name}" is not "" then
    repeat with w in windows of kiro
      try
        if name of w contains "${name}" then
          perform action "AXRaise" of w
          set matched to true
          exit repeat
        end if
      end try
    end repeat
  end if
  return (matched as string)
end tell`;
}

/** 归一化入参：既支持传对象，也兼容旧的仅传 workspaceName 字符串。 */
function normArgs(arg) {
  if (typeof arg === 'string') return { workspacePath: '', workspaceName: arg };
  return {
    workspacePath: (arg && arg.workspacePath) || '',
    workspaceName: (arg && arg.workspaceName) || '',
  };
}

/**
 * 聚焦某会话对应的 Kiro 窗口（点击列表项 / 通知「查看」时用）。
 * 优先走 CLI（全屏可靠），失败再退回 AppleScript。
 * @param {{workspacePath?:string, workspaceName?:string}|string} arg
 */
async function focusWorkspaceWindow(arg) {
  const { workspacePath, workspaceName } = normArgs(arg);
  const viaCli = await focusViaCli(workspacePath);
  if (viaCli.ok) return viaCli;
  return runOsascript(`
tell application id "${KIRO_BUNDLE_ID}" to activate
delay 0.15
${raiseWindowScript(workspaceName)}`);
}

/**
 * 一键重试：聚焦对应窗口 → ⌘L 聚焦聊天输入框 → 粘贴消息 → 回车。
 * 先用 CLI 把（可能全屏的）目标窗口带到前台，再用剪贴板粘贴以可靠输入中文，
 * 完成后恢复原剪贴板文本。
 *
 * @param {object} o
 * @param {string} o.workspacePath 工作区完整路径（CLI 聚焦用）
 * @param {string} o.workspaceName 工作区文件夹名（AppleScript 兜底匹配用）
 * @param {string} o.message       要发送的内容（默认「继续」）
 * @param {boolean} o.send         是否自动回车发送（false 则只填入不发送）
 */
async function retrySession({ workspacePath, workspaceName, message = '继续', send = true }) {
  // 1) 先把目标窗口带到前台（CLI 跨 Space/全屏；失败则 AppleScript 兜底并 AXRaise）
  const focused = await focusWorkspaceWindow({ workspacePath, workspaceName });

  // 2) 再发送按键（此时 Kiro 已在前台，键入落到当前聚焦的会话输入框）
  const msg = esc(message);
  const pressEnter = send
    ? `
  delay 0.12
  key code 36 -- Return 发送`
    : '';

  const script = `
set prevClip to ""
try
  set prevClip to (the clipboard as text)
end try
set the clipboard to "${msg}"

tell application id "${KIRO_BUNDLE_ID}" to activate
delay 0.25

tell application "System Events"
  keystroke "l" using {command down} -- ⌘L 聚焦 Kiro 聊天输入框
  delay 0.35
  keystroke "v" using {command down} -- 粘贴消息${pressEnter}
end tell

delay 0.3
try
  set the clipboard to prevClip -- 恢复原剪贴板
end try
return "done"`;

  const r = await runOsascript(script);
  // 聚焦阶段若因权限失败，冒泡出来以便上层引导授权
  if (!r.ok && focused && focused.needsPermission) return { ...r, needsPermission: true };
  return r;
}

/** 检测是否已获得辅助功能权限（不产生副作用的探测）。 */
async function checkAccessibility() {
  const script = `
tell application "System Events"
  try
    set n to count of (every process)
    return "ok"
  on error errMsg number errNum
    return "err:" & errNum
  end try
end tell`;
  const r = await runOsascript(script);
  return r.ok && r.stdout === 'ok';
}

module.exports = {
  KIRO_BUNDLE_ID,
  retrySession,
  focusWorkspaceWindow,
  checkAccessibility,
  resolveKiroCli,
};

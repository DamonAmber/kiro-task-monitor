'use strict';

const { execFile } = require('child_process');

const KIRO_BUNDLE_ID = 'dev.kiro.desktop';

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
 * 把某工作区对应的 Kiro 窗口置于最前。
 * @param {string} workspaceName 工作区文件夹名（用于匹配窗口标题）
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

/**
 * 仅聚焦某会话对应的 Kiro 窗口（点击列表项时用）。
 */
async function focusWorkspaceWindow(workspaceName) {
  const script = `
tell application id "${KIRO_BUNDLE_ID}" to activate
delay 0.15
${raiseWindowScript(workspaceName)}`;
  return runOsascript(script);
}

/**
 * 一键重试：置前对应窗口 → ⌘L 聚焦聊天输入框 → 粘贴消息 → 回车。
 * 使用剪贴板粘贴以可靠输入中文，完成后恢复原剪贴板文本。
 *
 * @param {object} o
 * @param {string} o.workspaceName 工作区文件夹名
 * @param {string} o.message       要发送的内容（默认「继续」）
 * @param {boolean} o.send         是否自动回车发送（false 则只填入不发送）
 */
async function retrySession({ workspaceName, message = '继续', send = true }) {
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
delay 0.2
${raiseWindowScript(workspaceName)}
delay 0.2

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

  return runOsascript(script);
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
};

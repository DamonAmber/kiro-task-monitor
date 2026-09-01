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
 * 激活 Kiro 并把标题含 workspaceName 的窗口置前——**能跨 Space / 全屏**。
 *
 * 原理（见实践验证）：`activate` 会自动切到该 app「当前活动窗口」所在的 Space
 * （包括全屏窗口的独立 Space），但切换要 ~0.4–0.5s，期间 System Events 看不到
 * 目标窗口、AXRaise 会"丢失"。所以：activate → 若当前 Space 看不到目标窗口就等
 * 切换完成 → 再 AXRaise。前提是目标窗口已是 Kiro 的活动窗口（由 `kiro <路径>`
 * 先行保证），这样 activate 才会切到正确的（可能是全屏的）Space。
 */
function focusScript(workspaceName) {
  const name = esc(workspaceName);
  return `
tell application id "${KIRO_BUNDLE_ID}" to activate
delay 0.2
tell application "System Events"
  if not (exists process "Kiro") then return "no-process"
  set kiro to first process whose bundle identifier is "${KIRO_BUNDLE_ID}"
  set frontmost of kiro to true
  set nm to "${name}"
  if nm is not "" then
    set canSee to false
    repeat with w in windows of kiro
      try
        if name of w contains nm then set canSee to true
      end try
    end repeat
    -- 目标窗口不在当前 Space（多为全屏/其它桌面）→ 等系统完成 Space 切换
    if not canSee then delay 0.55
    repeat with w in windows of kiro
      try
        if name of w contains nm then
          perform action "AXRaise" of w
          exit repeat
        end if
      end try
    end repeat
  end if
end tell
return "done"`;
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
 * 分两步以可靠跨 Space / 全屏：
 *   1) `kiro <路径>` 让目标窗口成为 Kiro 的「活动窗口」（即便它在别的 Space / 全屏）；
 *   2) AppleScript activate → 切到该活动窗口所在 Space（含全屏）→ 等切换完成 → AXRaise。
 * 缺了第 2 步时,单靠 CLI 往往只在内部聚焦、不触发系统级 Space 切换（全屏调不出来）。
 * @param {{workspacePath?:string, workspaceName?:string}|string} arg
 */
async function focusWorkspaceWindow(arg) {
  const { workspacePath, workspaceName } = normArgs(arg);
  const viaCli = await focusViaCli(workspacePath); // 第 1 步：选中目标窗口（不阻塞后续）
  const viaAS = await runOsascript(focusScript(workspaceName)); // 第 2 步：切 Space + 置前
  if (viaAS.ok || viaCli.ok) return { ok: true, via: viaCli.ok ? 'cli+as' : 'as' };
  return viaAS; // 冒泡权限等错误
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

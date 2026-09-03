'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  screen,
  shell,
  dialog,
  powerMonitor,
  nativeTheme,
} = require('electron');

const { autoUpdater } = require('electron-updater');
const { scanSessions, compareSessions, STATE } = require('./src/watcher');
const { scanClaudeSessions, getClaudePidsAsync } = require('./src/claudeWatcher');
const { readUsage } = require('./src/usage');
const { readOpenWindowContextAsync } = require('./src/openWindows');
const { checkPermissions } = require('./src/permissions');
const { buildReport } = require('./src/diagnostics');
const { buildStats } = require('./src/stats');
const { SESSIONS_DIR } = require('./src/kiroPaths');
const { makeTrayIcon } = require('./src/trayIcon');
const retry = require('./src/retry');
const { Config } = require('./src/config');
const webServer = require('./src/webServer');

let tray = null;
let win = null;
let config = null;
let pollTimer = null;
let usageTimer = null;
let winCtxTimer = null;
let permTimer = null; // 系统授权/能力自检的周期计时器
let sessionsWatcher = null; // fs.watch(SESSIONS_DIR) 句柄
let watchDebounce = null; // fs.watch 事件去抖计时器
let lastSessions = [];
let lastUsage = { ok: false, primary: null, breakdowns: [], timestamp: null };
// 系统授权/能力自检的最近一次结果（推给浮窗/局域网页面提醒用户去授权）
let lastPermissions = null;
// 每次启动只弹一次「缺授权」系统通知，避免刷屏（横幅会常驻提醒）
const permNotified = { accessibility: false, diskAccess: false };
// 当前打开的 Kiro 窗口/会话面板上下文（含 kiroRunning）。异步刷新、供 poll 复用，
// 避免每次轮询都同步 spawn sqlite3（性能）。null 时 scanSessions 降级为不过滤。
let cachedWinCtx = null;
let cachedClaudePids = null; // 当前存活的 Claude 会话进程 pid 集（异步刷新；null=未知，不判中断）
let trayAlert = false; // 托盘当前是否显示失败红点（用于变化时才重绘图标）
// 动态托盘：有会话运行中时让 ◐ 旋转。帧按 (alert,dark) 预生成后循环，(alert,dark) 变化才重建。
let trayAnimTimer = null;
let trayAnimFrames = null; // 当前 (alert,dark) 下预生成的 nativeImage 帧
let trayAnimIdx = 0;
let trayAnimKey = ''; // 'alert:dark' 签名，用于判断是否需要重建帧
const TRAY_FRAMES = 12; // 一圈的帧数（12 帧 × 130ms ≈ 1.56s/圈，平缓不晃眼）
let kiroDownSince = 0; // Kiro 首次被判定为「未运行」的时刻（0=当前认为在运行/未知）
// 中断判定防抖：Kiro 需被「持续」判定未运行超过该时长，才认定确实退出。
// 避免 pgrep 偶发漏读把运行中的会话瞬间错标为「已中断」。
const KIRO_DOWN_CONFIRM_MS = 20 * 1000;
let quittingForUpdate = false; // 正在为安装更新而退出（放行 window-all-closed 守卫）
// 局域网 Web 服务运行态（供设置面板展示网址/端口/错误）
let webInfo = { running: false, port: 0, addresses: [], error: '' };
let updateNotification = null; // 持有「更新已就绪」通知的引用，避免被 GC
// 更新状态，推送给渲染层用于设置里展示：idle/checking/available/downloading/downloaded/not-available/error/dev
let updateState = { status: 'idle', current: '', latest: '', progress: 0, error: '', readOnly: false };

// 识别「App 跑在只读卷 / 被 macOS 路径随机化(App Translocation)」导致无法自更新的错误
function isReadOnlyVolumeError(msg) {
  return /read-only|read only|readonly|AppTranslocation|move the application|Downloads directory/i.test(
    String(msg || '')
  );
}

function pushUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('update:state', updateState);
}

// 上一轮每个会话的状态，用于检测“状态跳变”并触发通知
// key -> { state, waitingSince, notifiedDone }
const prevStates = new Map();
let seeded = false; // 首轮只建立基线，不弹历史通知

const STATE_LABEL = {
  [STATE.RUNNING]: '运行中',
  [STATE.WAITING]: '等待你确认',
  [STATE.DONE]: '已完成',
  [STATE.FAILED]: '出错',
  [STATE.STUCK]: '疑似卡住',
  [STATE.CANCELLED]: '已取消',
  [STATE.IDLE]: '空闲',
};

/* ------------------------------------------------------------------ *
 * 浮窗
 * ------------------------------------------------------------------ */
// 各模式的默认尺寸与最小尺寸（极简模式可缩到很小）
const NORMAL_SIZE = { w: 340, h: 460, minW: 300, minH: 220 };
const COMPACT_SIZE = { w: 232, h: 300, minW: 180, minH: 96 };

function createWindow() {
  const compact = !!config.get('compactMode');
  const sz = compact ? COMPACT_SIZE : NORMAL_SIZE;
  let bounds = config.get(compact ? 'compactBounds' : 'bounds');
  if (!bounds) {
    const area = screen.getPrimaryDisplay().workArea;
    bounds = { x: area.x + area.width - sz.w - 16, y: area.y + 16, width: sz.w, height: sz.h };
  }

  win = new BrowserWindow({
    ...bounds,
    width: bounds.width || sz.w,
    height: bounds.height || sz.h,
    minWidth: sz.minW,
    minHeight: sz.minH,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: config.get('alwaysOnTop'),
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(config.get('alwaysOnTop'), 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // —— 诊断日志 ——
  win.webContents.on('did-finish-load', () =>
    console.log('[diag] renderer loaded; win bounds =', JSON.stringify(win.getBounds()), 'visible =', win.isVisible())
  );
  win.webContents.on('did-fail-load', (_e, code, desc) =>
    console.error('[diag] did-fail-load', code, desc)
  );
  win.webContents.on('render-process-gone', (_e, d) =>
    console.error('[diag] render-process-gone', JSON.stringify(d))
  );
  win.webContents.on('console-message', (_e, level, message, line, source) =>
    console.log(`[renderer:${level}] ${message} (${source}:${line})`)
  );

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    console.log('[diag] ready-to-show → shown at', JSON.stringify(win.getBounds()));
  });

  const persistBounds = () => {
    if (win && !win.isDestroyed()) {
      // 各模式的尺寸/位置分别记忆，互不覆盖
      config.set({ [config.get('compactMode') ? 'compactBounds' : 'bounds']: win.getBounds() });
    }
  };
  win.on('moved', persistBounds);
  win.on('resized', persistBounds);
  win.on('close', persistBounds);
  // 每次显示浮窗时复查授权（用户常在浮窗提示后去授予，回来即应看到最新状态）
  win.on('show', () => {
    if (typeof refreshPermissions === 'function') refreshPermissions();
  });
}

/** 切换极简/普通模式：调整最小尺寸并套用该模式记忆的尺寸（无记忆则用默认，保持当前位置）。 */
function applyCompactMode(compact) {
  if (!win || win.isDestroyed()) return;
  const sz = compact ? COMPACT_SIZE : NORMAL_SIZE;
  win.setMinimumSize(sz.minW, sz.minH);
  let b = config.get(compact ? 'compactBounds' : 'bounds');
  if (!b) {
    const cur = win.getBounds();
    b = { x: cur.x, y: cur.y, width: sz.w, height: sz.h };
  }
  win.setBounds(b);
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else {
    win.show();
    win.focus();
  }
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */
function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Kiro 任务监控');
  updateTrayTitle([]);
  tray.on('click', toggleWindow);
  tray.on('right-click', showTrayMenu);
}

function showTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: '显示/隐藏浮窗', click: toggleWindow },
    {
      label: '极简模式',
      type: 'checkbox',
      checked: !!config.get('compactMode'),
      click: (mi) => {
        config.set({ compactMode: mi.checked });
        applyCompactMode(mi.checked);
        poll(); // 立即把最新 config 推给渲染层，切换紧凑布局
      },
    },
    { type: 'separator' },
    {
      label: '出错时自动重试',
      type: 'checkbox',
      checked: !!config.get('autoRetry'),
      click: (mi) => config.set({ autoRetry: mi.checked }),
    },
    {
      label: '完成时通知',
      type: 'checkbox',
      checked: !!config.get('notifyDone'),
      click: (mi) => config.set({ notifyDone: mi.checked }),
    },
    {
      label: '置顶显示',
      type: 'checkbox',
      checked: !!config.get('alwaysOnTop'),
      click: (mi) => {
        config.set({ alwaysOnTop: mi.checked });
        if (win) win.setAlwaysOnTop(mi.checked, 'floating');
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.popUpContextMenu(menu);
}

function updateTrayTitle(sessions) {
  if (!tray) return;
  const failed = sessions.filter((s) => s.state === STATE.FAILED || s.state === STATE.STUCK).length;
  const running = sessions.filter((s) => s.state === STATE.RUNNING).length;
  const waiting = sessions.filter((s) => s.state === STATE.WAITING).length;

  // 菜单栏：图标 + 运行中会话数（无运行中则只留图标，保持干净）
  tray.setTitle(running > 0 ? ` ${running}` : '');

  // ⑥ 失败红点角标：有 failed/stuck（含"已中断"）时给图标叠红点；只在状态切换时重绘
  const alert = failed > 0;
  const alertChanged = alert !== trayAlert;
  trayAlert = alert;
  // 动态图标：有会话运行中 → 旋转动画；否则停到静态帧。避免空闲时每轮重复重绘。
  const shouldAnim = running > 0 && config && config.get('animateTray') !== false;
  if (shouldAnim) {
    startTrayAnim(); // 幂等；alert/dark 变化时动画循环内部会重建帧
  } else if (trayAnimTimer) {
    stopTrayAnim(); // 从动画切回静态：停止并恢复静态图（含告警红点）
  } else if (alertChanged) {
    applyTrayIcon(); // 本就静态：仅在告警态切换时重绘
  }

  // 详情放到悬停提示里，不占菜单栏空间
  const parts = [];
  if (running > 0) parts.push(`运行中 ${running}`);
  if (failed > 0) parts.push(`待处理 ${failed}`);
  if (waiting > 0) parts.push(`等待确认 ${waiting}`);
  tray.setToolTip(parts.length ? `Kiro 任务监控 · ${parts.join(' · ')}` : 'Kiro 任务监控');
}

/** 按当前告警状态 + 系统主题重建托盘图标（静态帧）。 */
function applyTrayIcon() {
  if (!tray) return;
  tray.setImage(makeTrayIcon({ alert: trayAlert, dark: nativeTheme.shouldUseDarkColors }));
}

/** 预生成当前 (alert,dark) 下一整圈的旋转帧，缓存起来循环用。 */
function buildTrayFrames() {
  const alert = trayAlert;
  const dark = nativeTheme.shouldUseDarkColors;
  const frames = [];
  for (let i = 0; i < TRAY_FRAMES; i++) {
    const angle = Math.PI / 2 + (i / TRAY_FRAMES) * Math.PI * 2;
    frames.push(makeTrayIcon({ alert, dark, angle }));
  }
  trayAnimFrames = frames;
  trayAnimKey = `${alert}:${dark}`;
}

/** 开始托盘旋转动画（幂等）。(alert,dark) 变化时会自动重建帧。 */
function startTrayAnim() {
  if (trayAnimTimer) return;
  trayAnimTimer = setInterval(() => {
    if (!tray) return;
    const key = `${trayAlert}:${nativeTheme.shouldUseDarkColors}`;
    if (!trayAnimFrames || trayAnimKey !== key) {
      buildTrayFrames();
      trayAnimIdx = 0;
    }
    trayAnimIdx = (trayAnimIdx + 1) % trayAnimFrames.length;
    tray.setImage(trayAnimFrames[trayAnimIdx]);
  }, 130);
}

/** 停止托盘动画并恢复静态 ◐（含告警红点 / 主题自适应）。 */
function stopTrayAnim() {
  if (trayAnimTimer) {
    clearInterval(trayAnimTimer);
    trayAnimTimer = null;
  }
  trayAnimFrames = null;
  trayAnimKey = '';
  trayAnimIdx = 0;
  applyTrayIcon();
}

/* ------------------------------------------------------------------ *
 * 通知
 * ------------------------------------------------------------------ */
function playSound(name = 'Basso') {
  execFile('afplay', [`/System/Library/Sounds/${name}.aiff`], () => {});
}

function notify({ title, body, session, isFailure }) {
  if (!Notification.isSupported()) return;
  // Claude 会话无法可靠聚焦终端/重试 → 通知不提供窗口动作，点击仅显示监控浮窗
  const actionable = !!session && session.source !== 'claude';
  const n = new Notification({
    title,
    body,
    silent: true, // 我们用 afplay 控制声音
    actions: actionable ? [{ type: 'button', text: isFailure ? '重试' : '查看' }] : [],
  });
  n.on('click', () => {
    if (actionable) {
      retry.focusWorkspaceWindow({ workspacePath: session.workspacePath, workspaceName: session.workspaceName });
    }
    if (win) win.show();
  });
  n.on('action', () => {
    if (!actionable) return;
    if (isFailure) doRetry(session);
    else retry.focusWorkspaceWindow({ workspacePath: session.workspacePath, workspaceName: session.workspaceName });
  });
  n.show();
  if (isFailure && config.get('soundOnFailed')) playSound('Basso');
}

function shortTitle(s) {
  const t = (s.title || '').replace(/\s+/g, ' ').trim();
  return t.length > 34 ? t.slice(0, 33) + '…' : t;
}

/* ------------------------------------------------------------------ *
 * 状态跳变 → 通知 / 自动重试
 * ------------------------------------------------------------------ */
function handleTransitions(sessions, now) {
  const minTurnMs = (config.get('notifyMinTurnSeconds') || 0) * 1000;
  const seenKeys = new Set();

  for (const s of sessions) {
    seenKeys.add(s.key);
    const prev = prevStates.get(s.key);
    const prevState = prev ? prev.state : null;
    const entry = prev || { state: null, waitingSince: 0, notifiedDone: false };

    if (!seeded) {
      // 首轮只建基线
      prevStates.set(s.key, { state: s.state, waitingSince: now, notifiedDone: s.state === STATE.DONE });
      continue;
    }

    const wsName = s.workspaceName || '(未知工作区)';

    // —— 进入 失败 / 卡住 ——
    if ((s.state === STATE.FAILED || s.state === STATE.STUCK) && prevState !== s.state) {
      // ① 确定性中断（Kiro 已不在运行）：不弹通知、不自动重试——用户此时不在 Kiro，
      //    也无从重试；只在浮窗/托盘红点里标记，等用户回来自行处理，避免退出 Kiro 时刷屏。
      if (!s.interrupted) {
        const canRetry = s.source !== 'claude'; // Claude 会话无法可靠重试
        if (config.get('notifyFailed')) {
          notify({
            title: s.state === STATE.FAILED ? `❌ 任务出错 · ${wsName}` : `⏳ 任务疑似卡住 · ${wsName}`,
            body:
              shortTitle(s) +
              (s.state === STATE.FAILED && s.stopReason ? `\n原因: ${s.stopReason}` : ''),
            session: s,
            isFailure: true,
          });
        }
        if (canRetry && config.get('autoRetry')) {
          doRetry(s);
        }
      }
    }

    // —— 进入 完成 —— （由 运行/等待/卡住 转来）
    if (
      s.state === STATE.DONE &&
      prevState && prevState !== STATE.DONE && prevState !== STATE.IDLE &&
      !entry.notifiedDone
    ) {
      const dur = s.turnDurationMs || s.elapsedMs || 0;
      const longEnough = dur === 0 || dur >= minTurnMs; // 未知耗时也通知
      if (config.get('notifyDone') && longEnough) {
        notify({
          title: `✅ 任务完成 · ${wsName}`,
          body: shortTitle(s),
          session: s,
          isFailure: false,
        });
      }
      entry.notifiedDone = true;
    }

    // —— 进入 等待你确认 —— （持续 > 一轮才通知，过滤秒批的授权）
    if (s.state === STATE.WAITING) {
      if (prevState !== STATE.WAITING) {
        entry.waitingSince = now;
        entry.waitingNotified = false;
      } else if (!entry.waitingNotified && now - (entry.waitingSince || now) >= 5000) {
        if (config.get('notifyWaiting')) {
          notify({
            title: `🟡 等待你确认 · ${wsName}`,
            body: shortTitle(s) + (s.question ? `\n${s.question}` : ''),
            session: s,
            isFailure: false,
          });
        }
        entry.waitingNotified = true;
      }
    }

    if (s.state !== STATE.DONE) entry.notifiedDone = false;
    entry.state = s.state;
    prevStates.set(s.key, entry);
  }

  // 清理已消失的会话
  for (const key of [...prevStates.keys()]) {
    if (!seenKeys.has(key)) prevStates.delete(key);
  }
  seeded = true;
}

/* ------------------------------------------------------------------ *
 * 重试
 * ------------------------------------------------------------------ */
async function doRetry(session) {
  const r = await retry.retrySession({
    workspacePath: session.workspacePath,
    workspaceName: session.workspaceName,
    message: config.get('retryMessage') || '继续',
    send: config.get('retrySend') !== false,
  });
  if (!r.ok && r.needsPermission) {
    notifyPermission();
  }
  return r;
}

function notifyPermission() {
  const n = new Notification({
    title: '需要「辅助功能」权限',
    body: '前往 系统设置 › 隐私与安全性 › 辅助功能，勾选 Electron / Kiro 任务监控，才能自动重试。点此打开设置。',
    silent: false,
  });
  n.on('click', () => {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    );
  });
  n.show();
}

/* ------------------------------------------------------------------ *
 * 轮询
 * ------------------------------------------------------------------ */
function poll() {
  const now = Date.now();
  const activeWithinMs = (config.get('activeWithinHours') || 24) * 3600 * 1000;
  const kiro = scanSessions({
    now,
    activeWithinMs,
    stuckMs: (config.get('stuckSeconds') || 240) * 1000,
    toolStuckMs: (config.get('toolStuckSeconds') || 1800) * 1000,
    stuckDetection: config.get('stuckDetection') !== false,
    onlyOpenSessions: config.get('onlyOpenSessions') !== false,
    onlyFocusedSession: !!config.get('onlyFocusedSession'),
    // 复用异步刷新的窗口上下文（不在轮询里同步 spawn sqlite3）；null 时降级为不过滤
    windowContext: cachedWinCtx,
    kiroRunning: effectiveKiroRunning(), // 带防抖，避免 pgrep 偶发漏读误判中断
  });

  // Claude Code 会话（只读；可在设置里关闭）。与 Kiro 合并后统一排序。
  let claude = [];
  if (config.get('watchClaude') !== false) {
    try {
      claude = scanClaudeSessions({ now, activeWithinMs, claudePids: cachedClaudePids });
    } catch (e) {
      console.error('[claude] scan failed:', e && e.message);
    }
  }

  const sessions = [...kiro, ...claude].sort(compareSessions);
  lastSessions = sessions;
  handleTransitions(sessions, now);
  updateTrayTitle(sessions);
  if (win && !win.isDestroyed()) {
    win.webContents.send('sessions:update', {
      sessions,
      config: config.data,
      usage: lastUsage,
      permissions: lastPermissions,
    });
  }
  broadcastWeb(); // 同步推给局域网浏览器（若已开启）
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, config.get('pollMs') || 2000);
}

/* ------------------------------------------------------------------ *
 * ④ 窗口上下文：异步刷新 + 缓存（不在轮询里同步 spawn sqlite3）
 *    ② 事件驱动：会话文件写入即触发一次（去抖）轮询，状态变化亚秒级反映
 * ------------------------------------------------------------------ */
async function refreshWinCtx() {
  try {
    cachedWinCtx = await readOpenWindowContextAsync();
  } catch {
    /* 读取失败保留上次值，不致命 */
  }
  // 维护「Kiro 持续未运行」计时：只有明确 false 才开始计时；true/未知则清零
  const kr = cachedWinCtx ? cachedWinCtx.kiroRunning : undefined;
  if (kr === false) {
    if (!kiroDownSince) kiroDownSince = Date.now();
  } else {
    kiroDownSince = 0;
  }
  // 顺带异步刷新 Claude 会话进程存活集（供中断判定/过滤已结束会话）
  if (config.get('watchClaude') !== false) {
    try {
      cachedClaudePids = await getClaudePidsAsync();
    } catch {
      /* 保留上次值 */
    }
  }
}

function startWinCtxPolling() {
  if (winCtxTimer) clearInterval(winCtxTimer);
  // 窗口/面板状态与 Kiro 进程存活变化较慢，8s 刷新一次足够，且不阻塞轮询
  winCtxTimer = setInterval(refreshWinCtx, 8000);
}

/**
 * 用于中断判定的「Kiro 是否在运行」——带防抖：
 * 只有当 Kiro 被**持续**判定未运行超过 KIRO_DOWN_CONFIRM_MS 才返回 false（确实退出），
 * 短暂/偶发的未命中返回 undefined（未知→不判中断），避免误标「已中断」。
 */
function effectiveKiroRunning() {
  const kr = cachedWinCtx ? cachedWinCtx.kiroRunning : undefined;
  if (kr === false) {
    return kiroDownSince && Date.now() - kiroDownSince >= KIRO_DOWN_CONFIRM_MS ? false : undefined;
  }
  return kr; // true 或 undefined 原样返回
}

// fs.watch 去抖：会话目录一有写入，200ms 内合并为一次 poll（亚秒级反映状态变化）
function schedulePollSoon() {
  if (watchDebounce) return;
  watchDebounce = setTimeout(() => {
    watchDebounce = null;
    poll();
  }, 200);
}

function startSessionsWatch() {
  try {
    if (sessionsWatcher) sessionsWatcher.close();
    sessionsWatcher = fs.watch(SESSIONS_DIR, { recursive: true }, () => schedulePollSoon());
  } catch {
    sessionsWatcher = null; // 监听失败不致命，兜底仍有定时轮询
  }
}

/* ------------------------------------------------------------------ *
 * 套餐用量（只读 Kiro 全局缓存，变化慢，单独用更长的间隔刷新）
 * ------------------------------------------------------------------ */
function refreshUsage() {
  try {
    lastUsage = readUsage();
  } catch (e) {
    // 读取异常时保留上一次的值，仅记录诊断日志
    console.error('[usage] refresh failed:', e && e.message);
    return;
  }
  if (win && !win.isDestroyed()) win.webContents.send('usage:update', lastUsage);
  broadcastWeb(); // 用量刷新也推给局域网浏览器
}

function startUsagePolling() {
  if (usageTimer) clearInterval(usageTimer);
  refreshUsage();
  usageTimer = setInterval(refreshUsage, config.get('usagePollMs') || 60000);
}

/* ------------------------------------------------------------------ *
 * 系统授权 / 能力自检
 *   启动时先查一次，之后周期性复查（用户可能中途才去授予辅助功能）。
 *   缺授权时：① 常驻横幅推给浮窗/局域网页面；② 每次启动弹一次系统通知提醒。
 * ------------------------------------------------------------------ */
/** 打开 macOS 隐私设置对应面板：辅助功能 / 完全磁盘访问权限。 */
function openPrivacySettings(which) {
  const pane =
    which === 'diskAccess'
      ? 'Privacy_AllFiles' // 完全磁盘访问权限
      : 'Privacy_Accessibility'; // 辅助功能（默认）
  shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
}

/** 缺授权时弹一次系统通知（每种问题每次启动只弹一次，避免刷屏）。 */
function maybeNotifyPermission(perm) {
  if (!perm || !perm.banner || !Notification.isSupported()) return;
  const { action, text } = perm.banner;
  if (action === 'diskAccess' && !permNotified.diskAccess) {
    permNotified.diskAccess = true;
  } else if (action === 'accessibility' && !permNotified.accessibility) {
    permNotified.accessibility = true;
  } else {
    return; // 该问题本次启动已提醒过
  }
  const n = new Notification({
    title: action === 'diskAccess' ? '需要「完全磁盘访问权限」' : '需要「辅助功能」权限',
    body: text + '\n点此打开系统设置。',
    silent: false,
  });
  n.on('click', () => openPrivacySettings(action));
  n.show();
}

async function refreshPermissions() {
  let perm;
  try {
    perm = await checkPermissions();
  } catch (e) {
    console.error('[perm] check failed:', e && e.message);
    return;
  }
  lastPermissions = perm;
  if (win && !win.isDestroyed()) win.webContents.send('permissions:state', perm);
  broadcastWeb(); // 局域网页面也能看到授权提示
  maybeNotifyPermission(perm);
}

function startPermissionPolling() {
  if (permTimer) clearInterval(permTimer);
  // 授权状态变化较慢（用户手动授予），15s 复查一次足够；sqlite3 结果已内部记忆
  permTimer = setInterval(refreshPermissions, 15000);
}

/* ------------------------------------------------------------------ *
 * 诊断报告：一键导出结构化、默认脱敏的 JSON，供用户发给维护者定位问题
 *   关键：另跑一次「不过滤」的全量扫描做对照，据此解释每个会话为何被显示/隐藏，
 *   不动热路径（poll 里的 lastSessions 仍是过滤后的结果）。
 * ------------------------------------------------------------------ */
async function generateDiagnostics({ includeSensitive } = {}) {
  const now = Date.now();
  const activeWithinMs = (config.get('activeWithinHours') || 24) * 3600 * 1000;
  // 过滤前的 Kiro 会话全集（onlyOpenSessions:false → 只打标不过滤），用来解释隐藏原因
  const raw = scanSessions({
    now,
    activeWithinMs,
    stuckMs: (config.get('stuckSeconds') || 240) * 1000,
    toolStuckMs: (config.get('toolStuckSeconds') || 1800) * 1000,
    stuckDetection: config.get('stuckDetection') !== false,
    onlyOpenSessions: false,
    onlyFocusedSession: false,
    windowContext: cachedWinCtx,
    kiroRunning: effectiveKiroRunning(),
  });
  const shownKeys = new Set(lastSessions.map((s) => s.key));
  const claudeShown = lastSessions.filter((s) => s.source === 'claude').length;

  let report;
  try {
    report = await buildReport({
      includeSensitive: !!includeSensitive,
      versions: { app: app.getVersion(), electron: process.versions.electron, node: process.versions.node },
      config: config.data,
      permissions: lastPermissions,
      winCtx: cachedWinCtx,
      sessionsRaw: raw,
      shownKeys,
      claudeShown,
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let downloads;
  try {
    downloads = app.getPath('downloads');
  } catch {
    downloads = app.getPath('home');
  }
  const defaultPath = path.join(downloads, `kiro-monitor-diagnostics-${ts}.json`);
  const { canceled, filePath } = await dialog.showSaveDialog(win || undefined, {
    title: '保存诊断报告',
    defaultPath,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
    return { ok: true, path: filePath, redacted: report.redacted };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* ------------------------------------------------------------------ *
 * 局域网 Web 访问（只读）：起 HTTP+SSE 服务，手机/平板浏览器全屏查看
 * ------------------------------------------------------------------ */
/** 首次开启时生成访问 PIN 与 cookie 密钥（缺失才生成，保证跨重启稳定）。 */
function ensureWebSecrets() {
  const patch = {};
  if (!config.get('webPin')) patch.webPin = String(Math.floor(100000 + Math.random() * 900000));
  if (!config.get('webToken')) patch.webToken = crypto.randomBytes(24).toString('hex');
  if (Object.keys(patch).length) config.set(patch);
}

function getWebState() {
  const port = webInfo.port || config.get('webPort') || 8787;
  // 把每个网卡地址拼成完整网址，标注网卡名与是否 Wi-Fi，交给设置面板全部展示
  const addresses = (webInfo.addresses || []).map((a) => ({
    url: `http://${a.address}:${port}`,
    iface: a.iface,
    isWifi: !!a.isWifi,
  }));
  return {
    enabled: !!config.get('webEnabled'),
    running: !!webInfo.running,
    port,
    addresses,
    pin: config.get('webPin') || '',
    error: webInfo.error || '',
  };
}

function pushWebState() {
  if (win && !win.isDestroyed()) win.webContents.send('web:state', getWebState());
}

// 桌面端的"显示"类开关（用量条 / 当前动作 / 迷你时间线）也要让局域网网页遵循，
// 否则在电脑上关掉了、手机端还照显。随快照一起下发给网页端。
function webUiFlags() {
  return {
    showUsage: config.get('showUsage') !== false,
    showActivity: config.get('showActivity') !== false,
    showTimeline: config.get('showTimeline') !== false,
  };
}

async function startWebServer() {
  ensureWebSecrets();
  try {
    const info = await webServer.start({
      port: config.get('webPort') || 8787,
      getPin: () => config.get('webPin'),
      getToken: () => config.get('webToken'),
      getSnapshot: () => ({
        sessions: lastSessions,
        usage: lastUsage,
        permissions: lastPermissions,
        ui: webUiFlags(),
        serverTime: Date.now(),
      }),
    });
    webInfo = { running: true, error: '', ...info };
    console.log(
      '[web] 局域网服务已启动:',
      (info.addresses || []).map((a) => `http://${a.address}:${info.port}${a.isWifi ? '(Wi-Fi)' : ''}`).join(' ')
    );
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.error('[web] 启动失败:', msg);
    webInfo = { running: false, port: 0, addresses: [], error: msg };
  }
  pushWebState();
  return webInfo;
}

async function stopWebServer() {
  try {
    await webServer.stop();
  } catch {
    /* ignore */
  }
  webInfo = { running: false, port: 0, addresses: [], error: '' };
  pushWebState();
}

/** 把当前会话/用量推给所有已连接的局域网客户端（仅在服务运行时）。 */
function broadcastWeb() {
  if (webInfo.running) {
    webServer.broadcast({
      sessions: lastSessions,
      usage: lastUsage,
      permissions: lastPermissions,
      ui: webUiFlags(),
      serverTime: Date.now(),
    });
  }
}

/**
 * 退出并安装更新，然后自动重启。
 * 菜单栏应用有两处会拦住"真正退出"：window-all-closed 的 preventDefault、
 * 以及窗口的 close 钩子。这里先放行/清理，再调用 quitAndInstall。
 * 关键：quitAndInstall(isSilent=false, isForceRunAfter=true) 的第二个参数为 true
 * 才会在安装后**自动重启**——默认 false 会导致"退出但不重启，得手动打开"。
 */
function restartToUpdate() {
  if (quittingForUpdate) return;
  quittingForUpdate = true;
  // 解除「关闭所有窗口不退出」守卫
  app.removeAllListeners('window-all-closed');
  // 主动销毁窗口，避免 close 钩子阻挠退出
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.removeAllListeners('close');
      w.destroy();
    } catch {
      /* ignore */
    }
  }
  // 延后一拍，确保通知回调先返回，再触发安装与重启
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      console.error('[update] quitAndInstall 失败，回退到普通退出：', e && e.message);
      app.quit(); // 至少退出，退出时会安装（autoInstallOnAppQuit）
    }
  });
}

/* ------------------------------------------------------------------ *
 * 自动更新（仅打包后的正式版启用；从 GitHub Releases 检查）
 * ------------------------------------------------------------------ */
function setupAutoUpdate() {
  updateState.current = app.getVersion();
  if (!app.isPackaged) {
    pushUpdateState({ status: 'dev' }); // 开发环境（npm start）不检查更新
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => pushUpdateState({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (i) => {
    pushUpdateState({ status: 'available', latest: (i && i.version) || '', progress: 0 });
  });
  autoUpdater.on('update-not-available', () => pushUpdateState({ status: 'not-available' }));
  autoUpdater.on('download-progress', (p) =>
    pushUpdateState({ status: 'downloading', progress: Math.round((p && p.percent) || 0) })
  );
  autoUpdater.on('error', (e) => {
    const msg = (e && e.message) || String(e);
    console.error('[update] error:', msg);
    pushUpdateState({ status: 'error', error: msg, readOnly: isReadOnlyVolumeError(msg) });
  });
  autoUpdater.on('update-downloaded', (i) => {
    pushUpdateState({ status: 'downloaded', latest: (i && i.version) || '' });
    if (!Notification.isSupported()) return;
    updateNotification = new Notification({
      title: '更新已就绪',
      body: `新版本 ${i && i.version} 已下载。点此立即重启更新（或到设置里点「重启并更新」）。`,
      silent: false,
      actions: [{ type: 'button', text: '立即重启' }],
    });
    updateNotification.on('click', restartToUpdate);
    updateNotification.on('action', restartToUpdate);
    updateNotification.show();
  });

  const check = () => autoUpdater.checkForUpdates().catch((e) => {
    const msg = (e && e.message) || String(e);
    pushUpdateState({ status: 'error', error: msg, readOnly: isReadOnlyVolumeError(msg) });
  });
  check();
  setInterval(check, 6 * 60 * 60 * 1000); // 每 6 小时检查一次
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('sessions:get', () => ({ sessions: lastSessions, config: config.data, usage: lastUsage }));
  ipcMain.handle('usage:get', () => lastUsage);
  ipcMain.handle('config:get', () => config.data);
  ipcMain.handle('config:set', (_e, patch) => {
    const data = config.set(patch || {});
    if (patch && 'pollMs' in patch) startPolling();
    if (patch && 'usagePollMs' in patch) startUsagePolling();
    if (patch && 'alwaysOnTop' in patch && win) win.setAlwaysOnTop(!!patch.alwaysOnTop, 'floating');
    if (patch && 'compactMode' in patch) applyCompactMode(!!patch.compactMode);
    // 显示类开关变更 → 立即推给局域网网页（否则要等下一次轮询才生效）
    if (patch && ('showUsage' in patch || 'showActivity' in patch || 'showTimeline' in patch)) {
      broadcastWeb();
    }
    return data;
  });
  ipcMain.handle('session:retry', async (_e, payload) => {
    const s = lastSessions.find((x) => x.key === (payload && payload.key)) || payload;
    return doRetry(s);
  });
  ipcMain.handle('session:focus', async (_e, payload) => {
    const s = lastSessions.find((x) => x.key === (payload && payload.key)) || payload || {};
    return retry.focusWorkspaceWindow({ workspacePath: s.workspacePath, workspaceName: s.workspaceName });
  });
  ipcMain.handle('window:hide', () => win && win.hide());
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:version', () => app.getVersion());

  // —— 系统授权 / 能力自检 —— //
  ipcMain.handle('permissions:get', () => lastPermissions);
  ipcMain.handle('permissions:recheck', async () => {
    await refreshPermissions();
    return lastPermissions;
  });
  ipcMain.handle('permissions:openSettings', (_e, which) => {
    openPrivacySettings(which);
    return { ok: true };
  });

  // —— 诊断报告 —— //
  ipcMain.handle('diagnostics:generate', (_e, opts) => generateDiagnostics(opts || {}));

  // —— 任务战报 / 历史统计（按需计算，不进 poll 热路径）—— //
  ipcMain.handle('stats:get', (_e, range) => {
    try {
      return buildStats({ range, now: Date.now() });
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  // —— 更新相关 —— //
  ipcMain.handle('update:state', () => updateState);
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) {
      pushUpdateState({ status: 'dev' });
      return { ok: false, dev: true };
    }
    try {
      pushUpdateState({ status: 'checking', error: '' });
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r && r.updateInfo && r.updateInfo.version };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      pushUpdateState({ status: 'error', error: msg, readOnly: isReadOnlyVolumeError(msg) });
      return { ok: false, error: msg };
    }
  });
  ipcMain.handle('update:install', () => {
    if (updateState.status !== 'downloaded') return { ok: false, error: 'no-update' };
    restartToUpdate();
    return { ok: true };
  });
  // 只读卷/路径随机化时，一键把 App 移到「应用程序」（成功会自动重启到新位置）
  ipcMain.handle('app:moveToApplications', () => moveToApplications());

  // —— 局域网访问 —— //
  ipcMain.handle('web:state', () => getWebState());
  ipcMain.handle('web:setEnabled', async (_e, enabled) => {
    config.set({ webEnabled: !!enabled });
    if (enabled) await startWebServer();
    else await stopWebServer();
    return getWebState();
  });
  ipcMain.handle('web:setPort', async (_e, port) => {
    const p = Math.max(1024, Math.min(65535, Number(port) || 8787));
    config.set({ webPort: p });
    if (config.get('webEnabled')) {
      await stopWebServer();
      await startWebServer();
    }
    return getWebState();
  });
  // 换一个 PIN：同时轮换 cookie 密钥（已登录的设备需重新输入 PIN），并重启服务生效
  ipcMain.handle('web:regen', async () => {
    config.set({
      webPin: String(Math.floor(100000 + Math.random() * 900000)),
      webToken: crypto.randomBytes(24).toString('hex'),
    });
    if (config.get('webEnabled')) {
      await stopWebServer();
      await startWebServer();
    }
    pushWebState();
    return getWebState();
  });
}

/* ------------------------------------------------------------------ *
 * 只读卷 / App Translocation 处理：引导移动到「应用程序」文件夹
 * ------------------------------------------------------------------ */
/** 把 App 移动到「应用程序」文件夹（成功后 Electron 自动重启到新位置）。 */
function moveToApplications() {
  if (process.platform !== 'darwin') return { ok: false, error: 'not-macos' };
  try {
    const ok = app.moveToApplicationsFolder();
    return { ok };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 启动时若发现 App 不在「应用程序」文件夹（多为从 DMG / 下载目录运行、或被 macOS
 * 路径随机化到只读位置），引导用户一键移动——否则 Squirrel 无法在只读卷上自更新。
 */
async function ensureInApplications() {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  let inApps = true;
  try {
    inApps = app.isInApplicationsFolder();
  } catch {
    return; // 判断失败就不打扰
  }
  if (inApps) return;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['移动到「应用程序」', '以后再说'],
    defaultId: 0,
    cancelId: 1,
    message: '建议把「Kiro 任务监控」移动到「应用程序」文件夹',
    detail:
      '它现在从只读位置运行（磁盘映像 DMG 或「下载」目录），macOS 会因此阻止自动更新。\n' +
      '移动到「应用程序」后即可正常自动升级，只需这一次。',
  });
  if (response !== 0) return;
  const r = moveToApplications();
  if (!r.ok) {
    await dialog.showMessageBox({
      type: 'error',
      message: '移动失败',
      detail:
        '请手动把「Kiro 任务监控」拖到「应用程序」文件夹后重新打开。\n' + (r.error || ''),
    });
  }
  // 成功时 moveToApplicationsFolder 已触发重启，无需其它处理
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  config = new Config(path.join(app.getPath('userData'), 'config.json'));
  if (app.dock) app.dock.hide(); // 菜单栏应用风格，不占 Dock

  // 若在只读位置运行，先引导移动到「应用程序」（用户同意则会自动重启，后续代码不再执行）
  await ensureInApplications();

  registerIpc();
  createWindow();
  createTray();
  // 先拿到一次窗口上下文（含 kiroRunning）再开始轮询，避免首帧因无过滤而闪现残留会话
  await refreshWinCtx();
  await refreshPermissions(); // 先体检一次授权/能力，让首帧就能带上提示
  startPolling();
  startWinCtxPolling(); // ④ 每 8s 异步刷新窗口上下文
  startSessionsWatch(); // ② 会话文件写入即触发轮询
  startUsagePolling();
  startPermissionPolling(); // 周期复查系统授权（用户可能中途才去授予）
  if (config.get('webEnabled')) startWebServer(); // 上次开启过则自动恢复局域网服务
  setupAutoUpdate();

  // ③ 休眠唤醒：重建通知基线（不对睡眠期间的跳变补发一堆通知），并立即刷新一次
  powerMonitor.on('resume', () => {
    seeded = false;
    refreshWinCtx().then(poll);
    refreshPermissions(); // 唤醒后复查授权状态
  });

  // 系统深/浅色切换：告警态的彩色图标需按主题重绘（无告警时是模板图，自动适应）
  nativeTheme.on('updated', () => {
    if (trayAlert) applyTrayIcon();
  });

  app.on('activate', () => {
    if (!win) createWindow();
    else win.show();
  });
});

// 菜单栏应用：平时关闭所有窗口不退出；但为安装更新而退出时放行
app.on('window-all-closed', (e) => {
  if (!quittingForUpdate) e.preventDefault();
});

// 退出前关闭局域网服务，释放端口与连接
app.on('before-quit', () => {
  try {
    webServer.stop();
  } catch {
    /* ignore */
  }
});

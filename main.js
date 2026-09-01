'use strict';

const path = require('path');
const fs = require('fs');
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
  powerMonitor,
  nativeTheme,
} = require('electron');

const { autoUpdater } = require('electron-updater');
const { scanSessions, compareSessions, STATE } = require('./src/watcher');
const { scanClaudeSessions, getClaudePidsAsync } = require('./src/claudeWatcher');
const { readUsage } = require('./src/usage');
const { readOpenWindowContextAsync } = require('./src/openWindows');
const { SESSIONS_DIR } = require('./src/kiroPaths');
const { makeTrayIcon } = require('./src/trayIcon');
const retry = require('./src/retry');
const { Config } = require('./src/config');

let tray = null;
let win = null;
let config = null;
let pollTimer = null;
let usageTimer = null;
let winCtxTimer = null;
let sessionsWatcher = null; // fs.watch(SESSIONS_DIR) 句柄
let watchDebounce = null; // fs.watch 事件去抖计时器
let lastSessions = [];
let lastUsage = { ok: false, primary: null, breakdowns: [], timestamp: null };
// 当前打开的 Kiro 窗口/会话面板上下文（含 kiroRunning）。异步刷新、供 poll 复用，
// 避免每次轮询都同步 spawn sqlite3（性能）。null 时 scanSessions 降级为不过滤。
let cachedWinCtx = null;
let cachedClaudePids = null; // 当前存活的 Claude 会话进程 pid 集（异步刷新；null=未知，不判中断）
let trayAlert = false; // 托盘当前是否显示失败红点（用于变化时才重绘图标）
let quittingForUpdate = false; // 正在为安装更新而退出（放行 window-all-closed 守卫）
let updateNotification = null; // 持有「更新已就绪」通知的引用，避免被 GC
// 更新状态，推送给渲染层用于设置里展示：idle/checking/available/downloading/downloaded/not-available/error/dev
let updateState = { status: 'idle', current: '', latest: '', progress: 0, error: '' };

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
function createWindow() {
  const WIDTH = 340;
  const HEIGHT = 460;
  let bounds = config.get('bounds');
  if (!bounds) {
    const area = screen.getPrimaryDisplay().workArea;
    bounds = { x: area.x + area.width - WIDTH - 16, y: area.y + 16, width: WIDTH, height: HEIGHT };
  }

  win = new BrowserWindow({
    ...bounds,
    width: WIDTH,
    height: HEIGHT,
    minWidth: 300,
    minHeight: 220,
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
    if (win && !win.isDestroyed()) config.set({ bounds: win.getBounds() });
  };
  win.on('moved', persistBounds);
  win.on('resized', persistBounds);
  win.on('close', persistBounds);
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
  if (alert !== trayAlert) {
    trayAlert = alert;
    applyTrayIcon();
  }

  // 详情放到悬停提示里，不占菜单栏空间
  const parts = [];
  if (running > 0) parts.push(`运行中 ${running}`);
  if (failed > 0) parts.push(`待处理 ${failed}`);
  if (waiting > 0) parts.push(`等待确认 ${waiting}`);
  tray.setToolTip(parts.length ? `Kiro 任务监控 · ${parts.join(' · ')}` : 'Kiro 任务监控');
}

/** 按当前告警状态 + 系统主题重建托盘图标。 */
function applyTrayIcon() {
  if (!tray) return;
  tray.setImage(makeTrayIcon({ alert: trayAlert, dark: nativeTheme.shouldUseDarkColors }));
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
    kiroRunning: cachedWinCtx ? cachedWinCtx.kiroRunning : undefined,
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
    win.webContents.send('sessions:update', { sessions, config: config.data, usage: lastUsage });
  }
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
}

function startUsagePolling() {
  if (usageTimer) clearInterval(usageTimer);
  refreshUsage();
  usageTimer = setInterval(refreshUsage, config.get('usagePollMs') || 60000);
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
    console.error('[update] error:', e && e.message);
    pushUpdateState({ status: 'error', error: (e && e.message) || String(e) });
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
    pushUpdateState({ status: 'error', error: (e && e.message) || String(e) });
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
      pushUpdateState({ status: 'error', error: (e && e.message) || String(e) });
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
  ipcMain.handle('update:install', () => {
    if (updateState.status !== 'downloaded') return { ok: false, error: 'no-update' };
    restartToUpdate();
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  config = new Config(path.join(app.getPath('userData'), 'config.json'));
  if (app.dock) app.dock.hide(); // 菜单栏应用风格，不占 Dock

  registerIpc();
  createWindow();
  createTray();
  // 先拿到一次窗口上下文（含 kiroRunning）再开始轮询，避免首帧因无过滤而闪现残留会话
  await refreshWinCtx();
  startPolling();
  startWinCtxPolling(); // ④ 每 8s 异步刷新窗口上下文
  startSessionsWatch(); // ② 会话文件写入即触发轮询
  startUsagePolling();
  setupAutoUpdate();

  // ③ 休眠唤醒：重建通知基线（不对睡眠期间的跳变补发一堆通知），并立即刷新一次
  powerMonitor.on('resume', () => {
    seeded = false;
    refreshWinCtx().then(poll);
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

'use strict';

const path = require('path');
const { execFile } = require('child_process');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');

const { autoUpdater } = require('electron-updater');
const { scanSessions, STATE } = require('./src/watcher');
const retry = require('./src/retry');
const { Config } = require('./src/config');

let tray = null;
let win = null;
let config = null;
let pollTimer = null;
let lastSessions = [];

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
  tray = new Tray(nativeImage.createEmpty());
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
  const failed = sessions.filter((s) => s.state === STATE.FAILED || s.state === STATE.STUCK).length;
  const running = sessions.filter((s) => s.state === STATE.RUNNING).length;
  const waiting = sessions.filter((s) => s.state === STATE.WAITING).length;
  let title = 'K';
  if (failed > 0) title = `K ❗${failed}`;
  else if (waiting > 0) title = `K ⏸${waiting}`;
  else if (running > 0) title = `K …${running}`;
  else title = 'K ✓';
  if (tray) tray.setTitle(` ${title}`);
}

/* ------------------------------------------------------------------ *
 * 通知
 * ------------------------------------------------------------------ */
function playSound(name = 'Basso') {
  execFile('afplay', [`/System/Library/Sounds/${name}.aiff`], () => {});
}

function notify({ title, body, session, isFailure }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title,
    body,
    silent: true, // 我们用 afplay 控制声音
    actions: session ? [{ type: 'button', text: isFailure ? '重试' : '查看' }] : [],
  });
  n.on('click', () => {
    if (session) retry.focusWorkspaceWindow(session.workspaceName);
    if (win) win.show();
  });
  n.on('action', () => {
    if (!session) return;
    if (isFailure) doRetry(session);
    else retry.focusWorkspaceWindow(session.workspaceName);
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
      if (config.get('autoRetry')) {
        doRetry(s);
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
  const sessions = scanSessions({
    now,
    activeWithinMs: (config.get('activeWithinHours') || 24) * 3600 * 1000,
    stuckMs: (config.get('stuckSeconds') || 120) * 1000,
    onlyOpenSessions: config.get('onlyOpenSessions') !== false,
    onlyFocusedSession: !!config.get('onlyFocusedSession'),
  });
  lastSessions = sessions;
  handleTransitions(sessions, now);
  updateTrayTitle(sessions);
  if (win && !win.isDestroyed()) {
    win.webContents.send('sessions:update', { sessions, config: config.data });
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, config.get('pollMs') || 2000);
}

/* ------------------------------------------------------------------ *
 * 自动更新（仅打包后的正式版启用；从 GitHub Releases 检查）
 * ------------------------------------------------------------------ */
function setupAutoUpdate() {
  if (!app.isPackaged) return; // 开发环境（npm start）不检查更新
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (e) => console.error('[update] error:', e && e.message));
  autoUpdater.on('update-available', (i) => console.log('[update] 发现新版本', i && i.version));
  autoUpdater.on('update-not-available', () => console.log('[update] 已是最新'));
  autoUpdater.on('update-downloaded', (i) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: '更新已就绪',
      body: `新版本 ${i && i.version} 已下载完成，退出后自动安装。点此立即重启更新。`,
      silent: false,
    });
    n.on('click', () => autoUpdater.quitAndInstall());
    n.show();
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000); // 每 6 小时检查一次
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('sessions:get', () => ({ sessions: lastSessions, config: config.data }));
  ipcMain.handle('config:get', () => config.data);
  ipcMain.handle('config:set', (_e, patch) => {
    const data = config.set(patch || {});
    if (patch && 'pollMs' in patch) startPolling();
    if (patch && 'alwaysOnTop' in patch && win) win.setAlwaysOnTop(!!patch.alwaysOnTop, 'floating');
    return data;
  });
  ipcMain.handle('session:retry', async (_e, payload) => {
    const s = lastSessions.find((x) => x.key === (payload && payload.key)) || payload;
    return doRetry(s);
  });
  ipcMain.handle('session:focus', async (_e, payload) => {
    const s = lastSessions.find((x) => x.key === (payload && payload.key)) || payload || {};
    return retry.focusWorkspaceWindow(s.workspaceName);
  });
  ipcMain.handle('window:hide', () => win && win.hide());
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:version', () => app.getVersion());
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
app.whenReady().then(() => {
  config = new Config(path.join(app.getPath('userData'), 'config.json'));
  if (app.dock) app.dock.hide(); // 菜单栏应用风格，不占 Dock

  registerIpc();
  createWindow();
  createTray();
  startPolling();
  setupAutoUpdate();

  app.on('activate', () => {
    if (!win) createWindow();
    else win.show();
  });
});

// 菜单栏应用：关闭所有窗口不退出
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

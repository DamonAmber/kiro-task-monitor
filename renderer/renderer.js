'use strict';

const appEl = document.getElementById('app');
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countsEl = document.getElementById('counts');
const settingsEl = document.getElementById('settings');

let lastPermissions = null; // 最近一次系统授权/能力自检结果

let compact = false;
function applyCompact() {
  if (appEl) appEl.classList.toggle('compact', compact);
}

// 卡片活动展示开关（由 config 同步）
let showActivity = true; // 显示"当前动作"（执行的工具 / 等待的问题）
let showTimeline = true; // 显示迷你活动时间线 sparkline

// 迷你活动时间线：把 activity（每桶事件计数）画成一排高低不一的细条
function sparklineHtml(activity) {
  if (!showTimeline || !Array.isArray(activity) || !activity.length) return '';
  const max = Math.max(1, ...activity);
  if (max <= 0) return '';
  const bars = activity
    .map((v) => {
      const h = v > 0 ? Math.max(18, Math.round((v / max) * 100)) : 0;
      return `<i style="height:${h}%"></i>`;
    })
    .join('');
  return `<div class="spark" title="近 10 分钟活动">${bars}</div>`;
}

// "当前动作"行：运行中显示正在执行的工具；等待你时显示 agent 抛出的问题
function activityHtml(s) {
  if (!showActivity) return '';
  if ((s.state === 'running' || s.state === 'stuck') && s.runningTool) {
    return `<div class="card-act"><span class="act-ic">⚙</span>执行 ${esc(s.runningTool)}</div>`;
  }
  if (s.state === 'waiting' && s.question) {
    return `<div class="card-act wait"><span class="act-ic">💬</span>${esc(s.question)}</div>`;
  }
  return '';
}

const STATE_LABEL = {
  running: '运行中',
  waiting: '等待你',
  done: '已完成',
  failed: '出错',
  stuck: '疑似卡住',
  cancelled: '已取消',
  idle: '空闲',
};

function fmtDur(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}时${m % 60}分`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

let currentSessions = [];

function render(sessions) {
  currentSessions = sessions;
  const failed = sessions.filter((s) => s.state === 'failed' || s.state === 'stuck').length;
  const running = sessions.filter((s) => s.state === 'running').length;
  const waiting = sessions.filter((s) => s.state === 'waiting').length;
  // 用带颜色的中文词表达，替代原来看不懂的 ❗/… 符号
  const segs = [];
  if (failed) segs.push(`<b class="c-fail">${failed} 待处理</b>`);
  if (waiting) segs.push(`<b class="c-wait">${waiting} 等待你</b>`);
  if (running) segs.push(`<b class="c-run">${running} 运行中</b>`);
  countsEl.innerHTML = sessions.length
    ? `共 ${sessions.length} 个${segs.length ? ' · ' + segs.join(' · ') : ''}`
    : '';

  if (!sessions.length) {
    emptyEl.textContent = emptyStateText();
    emptyEl.style.display = 'block';
    // 移除旧卡片
    [...listEl.querySelectorAll('.card')].forEach((n) => n.remove());
    return;
  }
  emptyEl.style.display = 'none';

  const html = sessions
    .map((s) => {
      // 确定性中断（Kiro 已不在运行）显示「已中断」，区别于超时猜测的「疑似卡住」
      const label = s.interrupted ? '已中断' : STATE_LABEL[s.state] || s.state;
      const isFail = s.state === 'failed' || s.state === 'stuck';
      const timeTxt =
        s.state === 'running' || s.state === 'waiting' || s.state === 'stuck'
          ? fmtDur(s.elapsedMs)
          : s.state === 'done'
          ? fmtDur(s.turnDurationMs)
          : '';
      const reason =
        s.state === 'failed' && s.stopReason ? ` · ${esc(s.stopReason)}` : '';
      const isClaude = s.source === 'claude';
      // 来源色片：Kiro（蓝）/ Claude（橙）——一眼区分，简洁
      const srcChip = `<span class="src ${isClaude ? 'src-claude' : 'src-kiro'}">${isClaude ? 'Claude' : 'Kiro'}</span>`;
      // Claude 会话无法可靠重试/聚焦终端 → 只读：不给重试按钮、卡片不可点聚焦
      const btn =
        isFail && !isClaude
          ? `<button class="retry-btn ${s.state === 'stuck' ? 'stuck' : ''}" data-retry="${esc(s.key)}">重试</button>`
          : '';
      const focusTag = s.isFocused ? '<span class="focus-tag" title="该窗口当前聚焦的会话">当前</span>' : '';
      const focusAttr = isClaude ? '' : ` data-focus="${esc(s.key)}"`;
      const cardTitle = isClaude ? ' title="Claude Code 会话（只读）"' : '';
      return `
      <div class="card${s.isFocused ? ' focused' : ''}${isClaude ? ' readonly' : ''}" data-source="${isClaude ? 'claude' : 'kiro'}"${focusAttr}${cardTitle}>
        <div class="dot ${s.state}"></div>
        <div class="card-main">
          <div class="card-title" title="${esc(s.title)}">${focusTag}${esc(s.title)}</div>
          <div class="card-meta">
            ${srcChip}
            <span class="state-label ${s.state}">${label}</span>
            ${timeTxt ? `<span>· ${timeTxt}</span>` : ''}
            <span class="ws">· ${esc(s.workspaceName || '—')}${reason}</span>
          </div>
          ${activityHtml(s)}
          ${sparklineHtml(s.activity)}
        </div>
        ${timeTxt ? `<span class="card-mini-time">${timeTxt}</span>` : ''}
        ${btn}
      </div>`;
    })
    .join('');

  // 用一个容器替换，避免闪烁：整体重建
  [...listEl.querySelectorAll('.card')].forEach((n) => n.remove());
  emptyEl.insertAdjacentHTML('afterend', html);
}

// 空态文案：会话数据读不出来时给出可操作的原因，否则就是普通的「暂无活跃会话」
function emptyStateText() {
  const p = lastPermissions;
  if (p && p.sessionsBlocked) return '无法读取 Kiro 会话数据 · 见下方授权提示';
  if (p && p.sessionsDir && !p.sessionsDir.ok && p.sessionsDir.error === 'ENOENT') {
    return '未找到 Kiro 会话数据（Kiro 运行过吗？）';
  }
  return '暂无活跃会话';
}

/* ---------- 系统授权 / 能力自检 ---------- */
const permBanner = document.getElementById('perm-banner');
const permBannerIcon = document.getElementById('perm-banner-icon');
const permBannerText = document.getElementById('perm-banner-text');
const permBannerBtn = document.getElementById('perm-banner-btn');
const permItemsEl = document.getElementById('perm-items');

function renderPermissions(perm) {
  if (!perm) return;
  lastPermissions = perm;

  // —— 顶部横幅：仅在有阻塞问题时显示 —— //
  const b = perm.banner;
  if (b) {
    permBanner.classList.remove('hidden', 'level-warn', 'level-error');
    permBanner.classList.add(b.level === 'error' ? 'level-error' : 'level-warn');
    permBannerIcon.textContent = b.level === 'error' ? '⛔️' : '⚠️';
    permBannerText.textContent = b.text;
    permBannerBtn.dataset.action = b.action || 'accessibility';
  } else {
    permBanner.classList.add('hidden');
  }

  // —— 设置面板里的逐项自检 —— //
  if (permItemsEl) {
    permItemsEl.innerHTML = (perm.items || [])
      .map((it) => {
        const mark = it.ok ? '✓' : it.unknown ? '—' : '✕';
        const cls = it.ok ? 'ok' : it.unknown ? 'unknown' : 'bad';
        const btn =
          !it.ok && !it.unknown && it.canOpenSettings
            ? `<button class="perm-fix nodrag" data-action="accessibility">去授权</button>`
            : '';
        return `
        <div class="perm-item ${cls}">
          <span class="perm-mark">${mark}</span>
          <span class="perm-label">${esc(it.label)}</span>
          ${btn}
          <div class="perm-detail">${esc(it.detail || '')}</div>
        </div>`;
      })
      .join('');
  }

  // 空态文案可能依赖授权结果，会话为空时刷新一下
  if (!currentSessions.length) {
    emptyEl.textContent = emptyStateText();
  }
}

// 横幅按钮：打开对应系统设置面板后主动复查一次
permBannerBtn.addEventListener('click', async () => {
  const action = permBannerBtn.dataset.action || 'accessibility';
  await window.api.openPermissionSettings(action);
  setTimeout(() => window.api.recheckPermissions(), 800);
});
// 设置面板里的「去授权」按钮（事件委托）
if (permItemsEl) {
  permItemsEl.addEventListener('click', async (e) => {
    const fix = e.target.closest('.perm-fix');
    if (!fix) return;
    await window.api.openPermissionSettings(fix.dataset.action || 'accessibility');
    setTimeout(() => window.api.recheckPermissions(), 800);
  });
}
const btnPermRecheck = document.getElementById('btn-perm-recheck');
if (btnPermRecheck) {
  btnPermRecheck.addEventListener('click', async () => {
    btnPermRecheck.disabled = true;
    btnPermRecheck.textContent = '检查中…';
    try {
      const st = await window.api.recheckPermissions();
      renderPermissions(st);
    } catch {}
    btnPermRecheck.textContent = '重新检查';
    btnPermRecheck.disabled = false;
  });
}
window.api.onPermissions((st) => renderPermissions(st));

/* ---------- 诊断报告 ---------- */
const btnDiag = document.getElementById('btn-diag');
const diagStatusEl = document.getElementById('diag-status');
const diagSensitiveEl = document.getElementById('diag-sensitive');
if (btnDiag) {
  btnDiag.addEventListener('click', async () => {
    btnDiag.disabled = true;
    btnDiag.textContent = '生成中…';
    if (diagStatusEl) {
      diagStatusEl.classList.remove('ok', 'err');
      diagStatusEl.textContent = '';
    }
    try {
      const r = await window.api.generateDiagnostics({
        includeSensitive: !!(diagSensitiveEl && diagSensitiveEl.checked),
      });
      if (r && r.ok) {
        diagStatusEl.classList.add('ok');
        diagStatusEl.textContent = `已保存${r.redacted ? '（已脱敏）' : '（含项目名/标题）'}：${r.path}`;
      } else if (r && r.canceled) {
        diagStatusEl.textContent = '已取消';
      } else {
        diagStatusEl.classList.add('err');
        diagStatusEl.textContent = `生成失败：${(r && r.error) || '未知错误'}`;
      }
    } catch (e) {
      diagStatusEl.classList.add('err');
      diagStatusEl.textContent = '生成失败';
    }
    btnDiag.textContent = '生成报告';
    btnDiag.disabled = false;
  });
}

/* ---------- 交互 ---------- */
listEl.addEventListener('click', async (e) => {
  const retryBtn = e.target.closest('[data-retry]');
  if (retryBtn) {
    e.stopPropagation();
    const key = retryBtn.getAttribute('data-retry');
    const s = currentSessions.find((x) => x.key === key);
    if (!s) return;
    retryBtn.classList.add('busy');
    retryBtn.textContent = '重试中…';
    const r = await window.api.retry({ key, workspaceName: s.workspaceName });
    retryBtn.classList.remove('busy');
    retryBtn.textContent = r && r.ok ? '已发送' : '失败';
    setTimeout(() => (retryBtn.textContent = '重试'), 1600);
    return;
  }
  const card = e.target.closest('[data-focus]');
  if (card) {
    const key = card.getAttribute('data-focus');
    const s = currentSessions.find((x) => x.key === key);
    if (s) window.api.focus({ key, workspaceName: s.workspaceName });
  }
});

/* ---------- 设置 ---------- */
document.getElementById('btn-settings').addEventListener('click', () => {
  settingsEl.classList.remove('hidden');
});
document.getElementById('btn-settings-close').addEventListener('click', () => {
  settingsEl.classList.add('hidden');
});
document.getElementById('btn-hide').addEventListener('click', () => window.api.hideWindow());
document.getElementById('btn-quit').addEventListener('click', () => window.api.quit());

/* ---------- 任务战报 / 历史统计 ---------- */
const statsEl = document.getElementById('stats');
let statsRange = 'today';
let statsLoading = false;

function fmtDurLong(ms) {
  if (!ms || ms < 0) return '0秒';
  return fmtDur(ms) || '0秒';
}

async function loadStats() {
  if (statsLoading) return;
  statsLoading = true;
  const metricsEl = document.getElementById('stats-metrics');
  if (metricsEl && !metricsEl.children.length) metricsEl.innerHTML = '<div class="stats-loading">统计中…</div>';
  try {
    const data = await window.api.getStats(statsRange);
    renderStats(data);
  } catch (e) {
    const note = document.getElementById('stats-note');
    if (note) note.textContent = '统计失败：' + ((e && e.message) || '未知错误');
  }
  statsLoading = false;
}

function renderStats(data) {
  const metricsEl = document.getElementById('stats-metrics');
  const chartEl = document.getElementById('stats-chart');
  const wsEl = document.getElementById('stats-ws');
  const modelEl = document.getElementById('stats-model');
  const failEl = document.getElementById('stats-fail');
  const noteEl = document.getElementById('stats-note');
  const failBlock = document.getElementById('stats-fail-block');
  if (!data || !data.ok) {
    if (metricsEl) metricsEl.innerHTML = '';
    if (noteEl) noteEl.textContent = '统计失败：' + ((data && data.error) || '未知错误');
    return;
  }
  const t = data.totals;

  // —— 指标磁贴 —— //
  metricsEl.innerHTML = `
    <div class="metric done"><b>${t.done}</b><span>完成</span></div>
    <div class="metric failed"><b>${t.failed}</b><span>出错</span></div>
    <div class="metric cancelled"><b>${t.cancelled}</b><span>取消</span></div>
    <div class="metric total"><b>${t.turns}</b><span>总轮次</span></div>
    <div class="metric-line">agent 活跃 <b>${fmtDurLong(t.activeMs)}</b> · 平均单轮 <b>${fmtDurLong(t.avgMs)}</b> · 最长 <b>${fmtDurLong(t.maxMs)}</b></div>`;

  // —— 时间直方图 —— //
  const b = data.buckets || { labels: [], done: [], failed: [] };
  const n = (b.done || []).length;
  let maxTot = 1;
  for (let i = 0; i < n; i++) maxTot = Math.max(maxTot, (b.done[i] || 0) + (b.failed[i] || 0));
  if (t.turns === 0) {
    chartEl.innerHTML = '<div class="stats-empty">该时段暂无结束的回合</div>';
  } else {
    const bars = [];
    for (let i = 0; i < n; i++) {
      const dv = b.done[i] || 0;
      const fv = b.failed[i] || 0;
      const dh = Math.round((dv / maxTot) * 100);
      const fh = Math.round((fv / maxTot) * 100);
      const lb = b.labels[i] || '';
      bars.push(
        `<div class="cbar" title="${esc(lb || '')} 完成 ${dv} · 出错 ${fv}">
          <div class="cbar-stack"><i class="cf" style="height:${fh}%"></i><i class="cd" style="height:${dh}%"></i></div>
          <span class="cbar-lb">${esc(lb)}</span>
        </div>`
      );
    }
    chartEl.innerHTML = `<div class="chart-bars">${bars.join('')}</div>`;
  }

  // —— 列表：工作区 / 模型 / 失败原因 —— //
  wsEl.innerHTML = listRows(
    data.byWorkspace,
    (r) => `${r.turns} 轮 · 完成 ${r.done}${r.failed ? ` · <span class="c-fail">出错 ${r.failed}</span>` : ''}`
  );
  modelEl.innerHTML = listRows(
    data.byModel,
    (r) => `${r.turns} 轮 · ${fmtDurLong(r.activeMs)}`
  );
  if (data.failReasons && data.failReasons.length) {
    failBlock.classList.remove('hidden');
    failEl.innerHTML = data.failReasons
      .map(
        (r) =>
          `<div class="stats-row"><span class="stats-row-name">${esc(r.reason)}</span><span class="stats-row-val c-fail">× ${r.count}</span></div>`
      )
      .join('');
  } else {
    failBlock.classList.add('hidden');
  }

  if (noteEl) {
    noteEl.textContent = `已扫描 ${data.sessionsScanned} 个会话 · 仅统计 Kiro 会话，模型为近似归属`;
  }
}

function listRows(arr, valFn) {
  if (!arr || !arr.length) return '<div class="stats-empty">暂无数据</div>';
  return arr
    .map(
      (r) =>
        `<div class="stats-row"><span class="stats-row-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="stats-row-val">${valFn(r)}</span></div>`
    )
    .join('');
}

const btnStats = document.getElementById('btn-stats');
if (btnStats) {
  btnStats.addEventListener('click', () => {
    statsEl.classList.remove('hidden');
    loadStats();
  });
}
const btnStatsClose = document.getElementById('btn-stats-close');
if (btnStatsClose) {
  btnStatsClose.addEventListener('click', () => statsEl.classList.add('hidden'));
}
document.querySelectorAll('.stats-range .seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    const r = btn.getAttribute('data-range');
    if (r === statsRange) return;
    statsRange = r;
    document.querySelectorAll('.stats-range .seg').forEach((b) => b.classList.toggle('active', b === btn));
    loadStats();
  });
});

function bindSettings(config) {
  document.querySelectorAll('[data-cfg]').forEach((el) => {
    const key = el.getAttribute('data-cfg');
    if (el.type === 'checkbox') el.checked = !!config[key];
    else el.value = config[key] ?? '';

    el.onchange = () => {
      let val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'number') val = Number(el.value);
      else val = el.value;
      window.api.setConfig({ [key]: val });
    };
  });
}

/* ---------- 更新 ---------- */
function renderUpdate(state) {
  if (!state) return;
  const statusEl = document.getElementById('update-status');
  const installBtn = document.getElementById('btn-install-update');
  const checkBtn = document.getElementById('btn-check-update');
  const moveBtn = document.getElementById('btn-move-app');
  const verEl = document.getElementById('version');
  if (verEl && state.current) verEl.textContent = `Kiro 任务监控 v${state.current}`;

  statusEl.classList.remove('ok', 'err');
  let text = '';
  let showInstall = false;
  let showMove = false;
  let checking = false;
  switch (state.status) {
    case 'checking':
      text = '正在检查更新…';
      checking = true;
      break;
    case 'available':
      text = `发现新版本 v${state.latest}，正在下载…`;
      break;
    case 'downloading':
      text = `下载中 ${state.progress || 0}%…`;
      break;
    case 'downloaded':
      text = `新版本 v${state.latest} 已就绪`;
      statusEl.classList.add('ok');
      showInstall = true;
      break;
    case 'not-available':
      text = '已是最新版本 ✓';
      statusEl.classList.add('ok');
      break;
    case 'error':
      if (state.readOnly) {
        // 只读卷 / 路径随机化：给可操作的中文提示，而不是原始英文报错
        text = '无法自动更新：App 当前从只读位置运行（DMG 或「下载」目录）。请移动到「应用程序」后重试。';
        showMove = true;
      } else {
        text = `检查失败：${state.error || '未知错误'}`;
      }
      statusEl.classList.add('err');
      break;
    case 'dev':
      text = '开发模式不检查更新';
      break;
    default:
      text = '';
  }
  statusEl.textContent = text;
  installBtn.classList.toggle('hidden', !showInstall);
  if (moveBtn) moveBtn.classList.toggle('hidden', !showMove);
  checkBtn.disabled = checking;
  checkBtn.textContent = checking ? '检查中…' : '检查更新';
}

document.getElementById('btn-check-update').addEventListener('click', () => {
  const statusEl = document.getElementById('update-status');
  statusEl.classList.remove('ok', 'err');
  statusEl.textContent = '正在检查更新…';
  window.api.checkUpdate();
});
document.getElementById('btn-install-update').addEventListener('click', () => {
  document.getElementById('update-status').textContent = '正在重启并安装…';
  window.api.installUpdate();
});
const btnMoveApp = document.getElementById('btn-move-app');
if (btnMoveApp) {
  btnMoveApp.addEventListener('click', async () => {
    document.getElementById('update-status').textContent = '正在移动到「应用程序」…';
    const r = await window.api.moveToApplications();
    // 成功会自动重启；失败则提示手动移动
    if (!r || !r.ok) {
      document.getElementById('update-status').textContent =
        '移动失败，请手动把 App 拖到「应用程序」文件夹后重新打开。';
    }
  });
}
window.api.onUpdateState((state) => renderUpdate(state));

/* ---------- 局域网访问 ---------- */
function renderLan(state) {
  if (!state) return;
  const toggle = document.getElementById('lan-toggle');
  const box = document.getElementById('lan-box');
  const urlsEl = document.getElementById('lan-urls');
  const pinEl = document.getElementById('lan-pin');
  const hintEl = document.getElementById('lan-hint');
  if (!toggle) return;

  toggle.checked = !!state.enabled;
  box.classList.toggle('hidden', !state.enabled);
  if (!state.enabled) return;

  if (state.error) {
    urlsEl.innerHTML = `<div class="lan-url-row lan-fail">启动失败：${esc(state.error)}</div>`;
  } else if (state.running) {
    const addrs = state.addresses || [];
    if (!addrs.length) {
      urlsEl.innerHTML = `<div class="lan-url-row lan-fail">未检测到局域网地址（是否连了网络？）</div>`;
    } else {
      // 全部地址逐行列出，Wi-Fi 已排在最前并标注，方便直接选对
      urlsEl.innerHTML = addrs
        .map((a) => {
          const tag = a.isWifi
            ? '<span class="lan-net wifi">Wi-Fi</span>'
            : `<span class="lan-net">${esc(a.iface || '有线')}</span>`;
          return `<div class="lan-url-row">${tag}<b class="lan-url">${esc(a.url)}</b></div>`;
        })
        .join('');
    }
  } else {
    urlsEl.innerHTML = `<div class="lan-url-row">正在启动…</div>`;
  }
  pinEl.textContent = state.pin || '——';
}

async function initLan() {
  const toggle = document.getElementById('lan-toggle');
  const regen = document.getElementById('lan-regen');
  if (!toggle) return;

  toggle.addEventListener('change', async () => {
    const st = await window.api.setWebEnabled(toggle.checked);
    renderLan(st);
  });
  regen.addEventListener('click', async () => {
    regen.disabled = true;
    const st = await window.api.regenWeb();
    renderLan(st);
    regen.disabled = false;
  });

  window.api.onWebState((st) => renderLan(st));
  try {
    renderLan(await window.api.getWebState());
  } catch {}
}

/* ---------- 套餐用量 ---------- */
const usageEl = document.getElementById('usage');
const usageMainEl = document.getElementById('usage-main');
const usagePctEl = document.getElementById('usage-pct');
const usageFillEl = document.getElementById('usage-fill');
const usageSubEl = document.getElementById('usage-sub');

let lastUsage = null;
let showUsage = true;

// 数字紧凑格式：整数直接显示，否则保留 1 位小数
function fmtNum(n) {
  if (!isFinite(n)) return '0';
  const r = Math.round(n * 10) / 10;
  return Math.abs(r - Math.round(r)) < 0.05 ? String(Math.round(r)) : r.toFixed(1);
}

// 重置日 → “N天后重置 / 明天重置 / 今天重置 / M月D日重置”
function fmtReset(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (days > 1) return `${days} 天后重置`;
  if (days === 1) return '明天重置';
  if (days === 0) return '今天重置';
  return `${d.getMonth() + 1}月${d.getDate()}日重置`;
}

// 快照写入时间 → “更新于 X 前”
function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function renderUsage() {
  if (!usageEl) return;
  const u = lastUsage;
  if (!showUsage || !u || !u.ok || !u.primary) {
    usageEl.classList.add('hidden');
    return;
  }
  const p = u.primary;
  usageEl.classList.remove('hidden');

  const pct = Math.max(0, Math.min(100, Number(p.percentageUsed) || 0));
  const unit = p.displayNamePlural || 'Credits';

  // 颜色分级：耗尽=红，>=80% 预警=黄，否则正常=绿
  usageEl.classList.remove('ok', 'warn', 'over');
  const level = p.overLimit ? 'over' : pct >= 80 ? 'warn' : 'ok';
  usageEl.classList.add(level);
  usageFillEl.style.width = (p.overLimit ? 100 : pct) + '%';

  if (p.overLimit) {
    // 真实超额数 Kiro 未落盘、拿不到，故不显示「超了多少」，只报「已耗尽」。
    usageMainEl.textContent = '额度已耗尽';
    usagePctEl.textContent = '已满';
  } else {
    usageMainEl.textContent = `剩 ${fmtNum(p.remaining)} / ${fmtNum(p.usageLimit)} ${unit}`;
    usagePctEl.textContent = `${fmtNum(pct)}%`;
  }
  // 副行：重置倒计时 + 数据新鲜度（用量是 Kiro 缓存快照、非实时，让新鲜度可见）
  const resetTxt = fmtReset(p.resetDate);
  const freshTxt = u.timestamp ? `更新于 ${fmtAgo(u.timestamp)}` : '';
  usageSubEl.textContent = [resetTxt, freshTxt].filter(Boolean).join(' · ');

  // 悬停看明细。超额时不展示具体数字（拿不到真实值），只提示已耗尽。
  const tip = (
    p.overLimit
      ? [
          `额度已耗尽（含超额部分）`,
          `套餐额度 ${fmtNum(p.usageLimit)} ${unit}`,
        ]
      : [
          `已用 ${fmtNum(p.currentUsage)} / ${fmtNum(p.usageLimit)} ${unit}（${fmtNum(pct)}%）`,
          `剩余 ${fmtNum(p.remaining)} ${unit}`,
        ]
  )
    .concat([
      p.resetDate ? `重置日 ${new Date(p.resetDate).toLocaleDateString()}` : '',
      u.timestamp ? `数据更新于 ${fmtAgo(u.timestamp)}` : '',
    ])
    .filter(Boolean)
    .join('\n');
  usageEl.title = tip;
}

window.api.onUsage((usage) => {
  lastUsage = usage;
  renderUsage();
});

/* ---------- 数据流 ---------- */
window.api.onSessions(({ sessions, config, usage, permissions }) => {
  if (permissions) renderPermissions(permissions); // 先更新授权状态，空态文案才准
  render(sessions || []);
  if (config && 'showUsage' in config) showUsage = !!config.showUsage;
  if (config && 'showActivity' in config) showActivity = config.showActivity !== false;
  if (config && 'showTimeline' in config) showTimeline = config.showTimeline !== false;
  if (config && 'compactMode' in config) {
    compact = !!config.compactMode;
    applyCompact();
    const cb = document.querySelector('[data-cfg="compactMode"]');
    if (cb) cb.checked = compact; // 托盘切换后同步设置里的勾选态
  }
  if (usage) lastUsage = usage;
  renderUsage();
});

(async () => {
  const cfg = await window.api.getConfig();
  showUsage = cfg.showUsage !== false;
  showActivity = cfg.showActivity !== false;
  showTimeline = cfg.showTimeline !== false;
  compact = !!cfg.compactMode;
  applyCompact();
  bindSettings(cfg);
  // 「显示套餐用量」开关即时生效，不必等下一轮推送
  const usageToggle = document.querySelector('[data-cfg="showUsage"]');
  if (usageToggle) {
    usageToggle.addEventListener('change', () => {
      showUsage = usageToggle.checked;
      renderUsage();
    });
  }
  // 「极简模式」开关即时切换布局（窗口尺寸由主进程调整）
  const compactToggle = document.querySelector('[data-cfg="compactMode"]');
  if (compactToggle) {
    compactToggle.addEventListener('change', () => {
      compact = compactToggle.checked;
      applyCompact();
    });
  }
  // 「当前动作」「迷你时间线」开关即时重绘卡片
  const activityToggle = document.querySelector('[data-cfg="showActivity"]');
  if (activityToggle) {
    activityToggle.addEventListener('change', () => {
      showActivity = activityToggle.checked;
      render(currentSessions);
    });
  }
  const timelineToggle = document.querySelector('[data-cfg="showTimeline"]');
  if (timelineToggle) {
    timelineToggle.addEventListener('change', () => {
      showTimeline = timelineToggle.checked;
      render(currentSessions);
    });
  }
  // 先拿授权自检结果，空态/横幅首帧就准确
  try {
    const perm = await window.api.getPermissions();
    if (perm) renderPermissions(perm);
  } catch {}
  const { sessions, usage } = await window.api.getSessions();
  render(sessions || []);
  if (usage) lastUsage = usage;
  renderUsage();
  try {
    const st = await window.api.getUpdateState();
    renderUpdate(st);
  } catch {}
  initLan();
})();

'use strict';

/*
 * 局域网只读监控页：通过 SSE(/api/stream) 实时接收主进程推送的 { sessions, usage, serverTime }，
 * 渲染成卡片。运行中/等待中的耗时在两次推送之间由本地时钟续算，显示更"活"。
 */

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countsEl = document.getElementById('counts');
const connEl = document.getElementById('conn');
const connTextEl = document.getElementById('conn-text');
const usageEl = document.getElementById('usage');
const usageMainEl = document.getElementById('usage-main');
const usagePctEl = document.getElementById('usage-pct');
const usageFillEl = document.getElementById('usage-fill');
const usageSubEl = document.getElementById('usage-sub');
const permBannerEl = document.getElementById('perm-banner');
const permBannerTextEl = document.getElementById('perm-banner-text');

let lastPermissions = null;

const STATE_LABEL = {
  running: '运行中',
  waiting: '等待你',
  done: '已完成',
  failed: '出错',
  stuck: '疑似卡住',
  cancelled: '已取消',
  idle: '空闲',
};
// 需要本地续算耗时的状态（正在计时）
const LIVE_STATES = new Set(['running', 'waiting', 'stuck']);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

function fmtDur(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}时${m % 60}分`;
}

let sessions = [];
let receivedAt = Date.now(); // 本帧数据到达的本地时刻，用于续算 running 耗时

function setConn(state) {
  // state: 'on' | 'off' | 'connecting'
  connEl.classList.remove('on', 'off');
  if (state === 'on') {
    connEl.classList.add('on');
    connTextEl.textContent = '已连接';
  } else if (state === 'off') {
    connEl.classList.add('off');
    connTextEl.textContent = '重连中…';
  } else {
    connTextEl.textContent = '连接中…';
  }
}

function renderCounts() {
  const failed = sessions.filter((s) => s.state === 'failed' || s.state === 'stuck').length;
  const running = sessions.filter((s) => s.state === 'running').length;
  const waiting = sessions.filter((s) => s.state === 'waiting').length;
  const segs = [];
  if (failed) segs.push(`<b class="c-fail">${failed} 待处理</b>`);
  if (waiting) segs.push(`<b class="c-wait">${waiting} 等待你</b>`);
  if (running) segs.push(`<b class="c-run">${running} 运行中</b>`);
  countsEl.innerHTML = sessions.length
    ? `${sessions.length} 个${segs.length ? ' · ' + segs.join(' · ') : ''}`
    : '';
}

function render() {
  renderCounts();

  if (!sessions.length) {
    emptyEl.textContent =
      lastPermissions && lastPermissions.sessionsBlocked
        ? '本机无法读取 Kiro 会话数据'
        : '暂无活跃会话';
    emptyEl.style.display = 'block';
    [...listEl.querySelectorAll('.card')].forEach((n) => n.remove());
    return;
  }
  emptyEl.style.display = 'none';

  const html = sessions
    .map((s) => {
      const label = s.interrupted ? '已中断' : STATE_LABEL[s.state] || s.state;
      const isClaude = s.source === 'claude';
      const live = LIVE_STATES.has(s.state);
      // running/waiting/stuck：本轮已运行时长（本地续算）；done：本轮耗时（静态）
      const baseMs = live ? s.elapsedMs || 0 : s.state === 'done' ? s.turnDurationMs || 0 : 0;
      const timeAttr = live
        ? ` data-live="1" data-base="${baseMs}"`
        : '';
      const timeTxt = fmtDur(live ? baseMs + (Date.now() - receivedAt) : baseMs);
      const reason = s.state === 'failed' && s.stopReason ? ` · ${esc(s.stopReason)}` : '';
      const srcChip = `<span class="src ${isClaude ? 'src-claude' : 'src-kiro'}">${
        isClaude ? 'Claude' : 'Kiro'
      }</span>`;
      const focusTag = s.isFocused ? '<span class="focus-tag">当前</span>' : '';
      return `
      <div class="card${s.isFocused ? ' focused' : ''}" data-source="${isClaude ? 'claude' : 'kiro'}">
        <div class="dot ${s.state}"></div>
        <div class="card-main">
          <div class="card-title">${focusTag}${esc(s.title)}</div>
          <div class="card-meta">
            ${srcChip}
            <span class="state-label ${s.state}">${label}</span>
            <span class="time"${timeAttr}>${timeTxt ? '· ' + timeTxt : ''}</span>
            <span class="ws">· ${esc(s.workspaceName || '—')}${reason}</span>
          </div>
        </div>
      </div>`;
    })
    .join('');

  [...listEl.querySelectorAll('.card')].forEach((n) => n.remove());
  emptyEl.insertAdjacentHTML('afterend', html);
}

// 每秒仅更新"正在计时"的耗时文本，无需整表重绘（不打断滚动）
function tick() {
  const now = Date.now();
  listEl.querySelectorAll('.time[data-live="1"]').forEach((el) => {
    const base = Number(el.getAttribute('data-base')) || 0;
    const txt = fmtDur(base + (now - receivedAt));
    el.textContent = txt ? '· ' + txt : '';
  });
}
setInterval(tick, 1000);

/* ---------- 套餐用量 ---------- */
function fmtNum(n) {
  if (!isFinite(n)) return '0';
  const r = Math.round(n * 10) / 10;
  return Math.abs(r - Math.round(r)) < 0.05 ? String(Math.round(r)) : r.toFixed(1);
}
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
function renderUsage(u) {
  if (!u || !u.ok || !u.primary) {
    usageEl.classList.add('hidden');
    return;
  }
  const p = u.primary;
  usageEl.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, Number(p.percentageUsed) || 0));
  const unit = p.displayNamePlural || 'Credits';
  usageEl.classList.remove('ok', 'warn', 'over');
  usageEl.classList.add(p.overLimit ? 'over' : pct >= 80 ? 'warn' : 'ok');
  usageFillEl.style.width = (p.overLimit ? 100 : pct) + '%';
  if (p.overLimit) {
    usageMainEl.textContent = '额度已耗尽';
    usagePctEl.textContent = '已满';
  } else {
    usageMainEl.textContent = `剩 ${fmtNum(p.remaining)} / ${fmtNum(p.usageLimit)} ${unit}`;
    usagePctEl.textContent = `${fmtNum(pct)}%`;
  }
  usageSubEl.textContent = fmtReset(p.resetDate);
}

/* ---------- 系统授权（只读远端只提示「本机核心能力」问题） ---------- */
// 辅助功能是本机重试/聚焦才需要的，远端浏览器无从操作，故这里只在
// 「会话数据读不出来」（sessionsBlocked）时提示，用来解释为什么列表为空。
function renderPermissions(perm) {
  lastPermissions = perm || null;
  if (perm && perm.sessionsBlocked) {
    permBannerTextEl.textContent =
      (perm.banner && perm.banner.text) || '本机无法读取 Kiro 会话数据，监控无法工作。';
    permBannerEl.classList.remove('hidden');
  } else {
    permBannerEl.classList.add('hidden');
  }
}

/* ---------- 数据流 ---------- */
function applyPayload(payload) {
  if (!payload) return;
  sessions = payload.sessions || [];
  receivedAt = Date.now();
  if ('permissions' in payload) renderPermissions(payload.permissions);
  render();
  renderUsage(payload.usage);
}

let es = null;
function connect() {
  setConn('connecting');
  es = new EventSource('/api/stream');
  es.onopen = () => setConn('on');
  es.onmessage = (e) => {
    try {
      applyPayload(JSON.parse(e.data));
    } catch (_) {
      /* 忽略心跳/坏帧 */
    }
  };
  es.onerror = () => {
    setConn('off');
    // EventSource 会自动重连；若是鉴权失效则刷新回登录页
    fetch('/api/state', { method: 'GET' })
      .then((r) => {
        if (r.status === 401) location.replace('/');
      })
      .catch(() => {});
  };
}

// 先探一次鉴权，未登录直接回登录页；已登录则建立 SSE
fetch('/api/state')
  .then((r) => {
    if (r.status === 401) {
      location.replace('/');
      return null;
    }
    return r.json();
  })
  .then((snap) => {
    if (snap) applyPayload(snap);
    connect();
  })
  .catch(() => connect());

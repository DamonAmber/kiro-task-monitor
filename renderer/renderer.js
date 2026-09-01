'use strict';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countsEl = document.getElementById('counts');
const settingsEl = document.getElementById('settings');

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
  countsEl.textContent = sessions.length
    ? `· ${sessions.length} 个 ${failed ? `· ❗${failed}` : ''}${running ? ` · …${running}` : ''}`
    : '';

  if (!sessions.length) {
    emptyEl.textContent = '暂无活跃会话';
    emptyEl.style.display = 'block';
    // 移除旧卡片
    [...listEl.querySelectorAll('.card')].forEach((n) => n.remove());
    return;
  }
  emptyEl.style.display = 'none';

  const html = sessions
    .map((s) => {
      const label = STATE_LABEL[s.state] || s.state;
      const isFail = s.state === 'failed' || s.state === 'stuck';
      const timeTxt =
        s.state === 'running' || s.state === 'waiting' || s.state === 'stuck'
          ? fmtDur(s.elapsedMs)
          : s.state === 'done'
          ? fmtDur(s.turnDurationMs)
          : '';
      const reason =
        s.state === 'failed' && s.stopReason ? ` · ${esc(s.stopReason)}` : '';
      const btn = isFail
        ? `<button class="retry-btn ${s.state === 'stuck' ? 'stuck' : ''}" data-retry="${esc(s.key)}">重试</button>`
        : '';
      return `
      <div class="card" data-focus="${esc(s.key)}">
        <div class="dot ${s.state}"></div>
        <div class="card-main">
          <div class="card-title" title="${esc(s.title)}">${esc(s.title)}</div>
          <div class="card-meta">
            <span class="state-label ${s.state}">${label}</span>
            ${timeTxt ? `<span>· ${timeTxt}</span>` : ''}
            <span class="ws">· ${esc(s.workspaceName || '—')}${reason}</span>
          </div>
        </div>
        ${btn}
      </div>`;
    })
    .join('');

  // 用一个容器替换，避免闪烁：整体重建
  [...listEl.querySelectorAll('.card')].forEach((n) => n.remove());
  emptyEl.insertAdjacentHTML('afterend', html);
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

/* ---------- 数据流 ---------- */
window.api.onSessions(({ sessions, config }) => {
  render(sessions || []);
});

(async () => {
  const cfg = await window.api.getConfig();
  bindSettings(cfg);
  const { sessions } = await window.api.getSessions();
  render(sessions || []);
  try {
    const v = await window.api.getVersion();
    const el = document.getElementById('version');
    if (el) el.textContent = `Kiro 任务监控 v${v}`;
  } catch {}
})();

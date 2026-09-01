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
    emptyEl.textContent = '暂无活跃会话';
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
      <div class="card${s.isFocused ? ' focused' : ''}${isClaude ? ' readonly' : ''}"${focusAttr}${cardTitle}>
        <div class="dot ${s.state}"></div>
        <div class="card-main">
          <div class="card-title" title="${esc(s.title)}">${focusTag}${esc(s.title)}</div>
          <div class="card-meta">
            ${srcChip}
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

/* ---------- 更新 ---------- */
function renderUpdate(state) {
  if (!state) return;
  const statusEl = document.getElementById('update-status');
  const installBtn = document.getElementById('btn-install-update');
  const checkBtn = document.getElementById('btn-check-update');
  const verEl = document.getElementById('version');
  if (verEl && state.current) verEl.textContent = `Kiro 任务监控 v${state.current}`;

  statusEl.classList.remove('ok', 'err');
  let text = '';
  let showInstall = false;
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
      text = `检查失败：${state.error || '未知错误'}`;
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
window.api.onUpdateState((state) => renderUpdate(state));

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
  const sym = (p.currency && p.currency.symbol) || '';

  // 颜色分级：超额=红，>=80% 预警=黄，否则正常=绿
  usageEl.classList.remove('ok', 'warn', 'over');
  const level = p.overLimit ? 'over' : pct >= 80 ? 'warn' : 'ok';
  usageEl.classList.add(level);
  usageFillEl.style.width = (p.overLimit ? 100 : pct) + '%';

  if (p.overLimit) {
    const over = p.currentOverages || Math.max(p.currentUsage - p.usageLimit, 0);
    const charge = p.overageCharges > 0 ? ` · ${sym}${fmtNum(p.overageCharges)}` : '';
    usageMainEl.textContent = `已超 ${fmtNum(over)} ${unit}${charge}`;
    usagePctEl.textContent = `${fmtNum(pct)}%`;
  } else {
    usageMainEl.textContent = `剩 ${fmtNum(p.remaining)} / ${fmtNum(p.usageLimit)} ${unit}`;
    usagePctEl.textContent = `${fmtNum(pct)}%`;
  }
  // 副行：重置倒计时 + 数据新鲜度（用量是 Kiro 缓存快照、非实时，让新鲜度可见）
  const resetTxt = fmtReset(p.resetDate);
  const freshTxt = u.timestamp ? `更新于 ${fmtAgo(u.timestamp)}` : '';
  usageSubEl.textContent = [resetTxt, freshTxt].filter(Boolean).join(' · ');

  // 悬停看完整明细
  const tip = [
    `已用 ${fmtNum(p.currentUsage)} / ${fmtNum(p.usageLimit)} ${unit}（${fmtNum(pct)}%）`,
    p.overLimit
      ? `超额 ${fmtNum(p.currentOverages)} ${unit}，费用 ${sym}${fmtNum(p.overageCharges)}${p.overageRate ? `（单价 ${sym}${p.overageRate}）` : ''}`
      : `剩余 ${fmtNum(p.remaining)} ${unit}`,
    p.resetDate ? `重置日 ${new Date(p.resetDate).toLocaleDateString()}` : '',
    u.timestamp ? `数据更新于 ${fmtAgo(u.timestamp)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  usageEl.title = tip;
}

window.api.onUsage((usage) => {
  lastUsage = usage;
  renderUsage();
});

/* ---------- 数据流 ---------- */
window.api.onSessions(({ sessions, config, usage }) => {
  render(sessions || []);
  if (config && 'showUsage' in config) showUsage = !!config.showUsage;
  if (usage) lastUsage = usage;
  renderUsage();
});

(async () => {
  const cfg = await window.api.getConfig();
  showUsage = cfg.showUsage !== false;
  bindSettings(cfg);
  // 「显示套餐用量」开关即时生效，不必等下一轮推送
  const usageToggle = document.querySelector('[data-cfg="showUsage"]');
  if (usageToggle) {
    usageToggle.addEventListener('change', () => {
      showUsage = usageToggle.checked;
      renderUsage();
    });
  }
  const { sessions, usage } = await window.api.getSessions();
  render(sessions || []);
  if (usage) lastUsage = usage;
  renderUsage();
  try {
    const st = await window.api.getUpdateState();
    renderUpdate(st);
  } catch {}
})();

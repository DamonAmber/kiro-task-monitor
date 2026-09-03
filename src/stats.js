'use strict';

/**
 * 任务战报 / 历史统计（只读）。
 *
 * 汇总本机 Kiro 会话的 messages.jsonl 里的「回合」（turn_start / turn_end）数据，
 * 产出某时间范围（今日 / 近 7 天）内的：完成 / 出错 / 取消 计数、agent 活跃总时长、
 * 平均单轮耗时、按工作区 / 模型 拆分、失败原因分布、以及一条按小时/按天的时间直方图。
 *
 * 设计：
 * - 与实时监控解耦：面板打开时按需计算一次（不进 poll 热路径），不影响性能。
 * - 只读、绝不写入 ~/.kiro（沿用全局铁律）。
 * - 用文件 mtime 预过滤：最后修改早于时间窗起点的会话不可能有窗内事件，直接跳过，
 *   大幅减少要读的文件。
 * - 模型归属为近似：同一会话的所有回合都记到 session.json 当前的 modelId 名下
 *   （历史 turn 事件不带模型信息，session.json 只存当前模型）。
 * - 仅统计 Kiro 会话；Claude Code 会话的 transcript 结构不同，暂不纳入。
 */

const fs = require('fs');
const { listSessionDirs, readSessionMeta, FAIL_REASONS } = require('./watcher');

const MAX_FILE_BYTES = 64 * 1024 * 1024; // 单个 messages.jsonl 超过此大小则跳过解析（极端情况护栏）

/**
 * 依据范围构造时间直方图的桶（含起点 start，供 buildStats 用作 since 保证一致）。
 * - today：从本地零点起，24 个小时桶；
 * - 7d：从 6 天前的本地零点起，7 个天桶（含今天）。
 */
function makeBuckets(range, now) {
  if (range === '7d') {
    const days = 7;
    const base = new Date(now);
    base.setHours(0, 0, 0, 0);
    const start = base.getTime() - (days - 1) * 86400000;
    const labels = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start + i * 86400000);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
    return { count: days, labels, start, span: 86400000, unit: 'day' };
  }
  // today（默认）：本地零点起 24 小时桶
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const start = base.getTime();
  const count = 24;
  const labels = [];
  for (let i = 0; i < count; i++) labels.push(i % 6 === 0 ? `${i}时` : ''); // 稀疏标签，避免拥挤
  return { count, labels, start, span: 3600000, unit: 'hour' };
}

function bucketIndex(t, start, span, count) {
  if (t < start) return -1;
  const i = Math.floor((t - start) / span);
  return i >= 0 && i < count ? i : -1;
}

/** 累加到「按维度」统计表：key → { turns, done, failed, cancelled, activeMs }。 */
function accum(map, key, cat, dur) {
  let e = map.get(key);
  if (!e) {
    e = { turns: 0, done: 0, failed: 0, cancelled: 0, activeMs: 0 };
    map.set(key, e);
  }
  e.turns += 1;
  e[cat] += 1;
  if (cat !== 'cancelled') e.activeMs += dur;
}

/** Map → 数组，按回合数降序，取前 topN，附带 name 字段。 */
function topList(map, topN = 6) {
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.turns - a.turns || b.activeMs - a.activeMs)
    .slice(0, topN);
}

/**
 * 汇总某范围内的任务战报。
 * @param {object} opts { range:'today'|'7d', now }
 * @returns {object} 见文件头注释
 */
function buildStats(opts = {}) {
  const range = opts.range === '7d' ? '7d' : 'today';
  const now = opts.now || Date.now();
  const buckets = makeBuckets(range, now);
  const since = buckets.start; // 与直方图起点严格一致

  const totals = { turns: 0, done: 0, failed: 0, cancelled: 0, activeMs: 0, maxMs: 0 };
  const byWs = new Map();
  const byModel = new Map();
  const failReasons = new Map();
  const bDone = new Array(buckets.count).fill(0);
  const bFailed = new Array(buckets.count).fill(0);
  let sessionsScanned = 0;

  let dirs = [];
  try {
    dirs = listSessionDirs();
  } catch {
    dirs = [];
  }

  for (const d of dirs) {
    // mtime 预过滤：最后修改早于 since → 不可能有窗内 turn_end，跳过
    let mMtime = 0;
    let mSize = 0;
    try {
      const st = fs.statSync(d.messages);
      mMtime = st.mtimeMs;
      mSize = st.size;
    } catch {
      continue; // 无 messages.jsonl → 无回合可统计
    }
    if (Math.max(d.mtimeMs || 0, mMtime) < since) continue;
    if (mSize > MAX_FILE_BYTES) continue; // 超大文件护栏

    const meta = readSessionMeta(d.sessionJson);
    if (!meta) continue;

    let text;
    try {
      text = fs.readFileSync(d.messages, 'utf8');
    } catch {
      continue;
    }
    sessionsScanned += 1;

    const wsName = meta.workspaceName || '(未知工作区)';
    const model = shortenModel(meta.modelId) || '(未知模型)';

    let lastStart = 0;
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let ev;
      try {
        ev = JSON.parse(s);
      } catch {
        continue;
      }
      const p = ev && ev.payload;
      if (!p) continue;
      const t = Date.parse(ev.timestamp) || 0;

      if (p.type === 'turn_start') {
        lastStart = t;
      } else if (p.type === 'turn_end') {
        if (t < since || t > now) continue;
        const reason = p.stopReason || 'end_turn';
        const dur = lastStart && t >= lastStart ? t - lastStart : 0;
        let cat;
        if (FAIL_REASONS.has(reason)) cat = 'failed';
        else if (reason === 'cancelled') cat = 'cancelled';
        else cat = 'done';

        totals.turns += 1;
        totals[cat] += 1;
        if (cat !== 'cancelled') {
          totals.activeMs += dur;
          if (dur > totals.maxMs) totals.maxMs = dur;
        }
        accum(byWs, wsName, cat, dur);
        accum(byModel, model, cat, dur);
        if (cat === 'failed') failReasons.set(reason, (failReasons.get(reason) || 0) + 1);

        const bi = bucketIndex(t, buckets.start, buckets.span, buckets.count);
        if (bi >= 0) {
          if (cat === 'failed') bFailed[bi] += 1;
          else if (cat === 'done') bDone[bi] += 1;
        }
      }
    }
  }

  // 平均单轮：只对有耗时的回合（完成 + 出错）取均值
  const timedTurns = totals.done + totals.failed;
  const avgMs = timedTurns ? Math.round(totals.activeMs / timedTurns) : 0;

  return {
    ok: true,
    range,
    since,
    now,
    totals: { ...totals, avgMs },
    buckets: { unit: buckets.unit, labels: buckets.labels, done: bDone, failed: bFailed },
    byWorkspace: topList(byWs),
    byModel: topList(byModel),
    failReasons: [...failReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    sessionsScanned,
  };
}

// 厂商 / 区域前缀（形如 us.anthropic.claude-... / bedrock.claude-...）；逐段剥离
const MODEL_PREFIX = /^(anthropic|aws|amazon|bedrock|openai|google|azure|us|eu|apac|global)\./i;

/**
 * 把冗长的 modelId 收敛成人类可读的短名：只剥掉厂商/区域前缀，保留版本号里的点
 * （如 claude-opus-4.8 保持原样，而不是被截成 "8"）。
 */
function shortenModel(id) {
  if (!id) return '';
  let s = String(id);
  while (MODEL_PREFIX.test(s)) s = s.replace(MODEL_PREFIX, '');
  return s.length > 28 ? s.slice(0, 27) + '…' : s;
}

module.exports = { buildStats, makeBuckets, shortenModel };

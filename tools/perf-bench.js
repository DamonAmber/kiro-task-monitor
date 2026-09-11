'use strict';

/**
 * 性能基准 / 回归防线（`npm run perf`）。
 *
 * 本工具是小而美的桌面浮窗，`poll()` 每 ~2s 在**主进程主线程同步**跑一遍所有 watcher 的扫描。
 * 一旦某个 watcher 在热路径上做了重活（例：v0.11.0 曾每轮全量解压多 MB 的 dsh zstd 会话 →
 * 主线程被阻塞数秒 → 拖不动、点击无响应），整个 UI 就会卡死。这个基准把「扫描热路径必须很快」
 * 固化成可复跑、带阈值的 gate：超标即非零退出，发版前必须通过。
 *
 * 两部分：
 *  A) 真实数据基准：用本机 ~/.kiro / ~/.claude / ~/.dsh 跑各 watcher 的**稳态**扫描（缓存命中、
 *     无变化），测 ms/轮。这是 poll 每 2s 的实际开销，必须极低。
 *  B) dsh 合成最坏情况：把自带的小种子帧拼接成一个 ~4MB 的「活跃大会话」（不依赖本机数据、可复现），
 *     测冷启动扫描、稳态、以及**活跃增量**（每轮追加新帧后再扫描——直接复现卡顿事故场景）。
 *     因 DSH_HOME 在模块加载时读取，本部分在带 DSH_HOME 的子进程里隔离运行。
 *
 * 用法：
 *   npm run perf            # 全量：真实数据 + 合成最坏情况
 *   node tools/perf-bench.js --json   # 额外输出机器可读 JSON
 *   （内部）node tools/perf-bench.js --synth   # 子进程模式，仅跑合成 dsh（需 DSH_HOME 指向临时目录）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ── 阈值（超标 = 回归）。可用环境变量覆盖（CI 调优 / 自测 gate 用）──────────
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const THRESHOLDS = {
  steadyMsPerRound: num(process.env.PERF_STEADY_MS, 50), // 稳态/增量单轮扫描上限（poll 每 2s，50ms 完全无感）
  incrementMsPerRound: num(process.env.PERF_INCREMENT_MS, 50), // dsh 活跃会话「每轮追加后再扫描」单轮上限
  coldMs: num(process.env.PERF_COLD_MS, 3000), // 合成 ~4MB 大会话首轮冷启动上限（一次性，宽松）
};
const SYNTH_TARGET_BYTES = 4 * 1024 * 1024; // 合成活跃大会话目标压缩体积
const SEED = path.join(__dirname, '..', 'test', 'fixtures', 'dsh-seed.jsonl.zstd');

function nowNs() {
  return process.hrtime.bigint();
}
function msSince(t0) {
  return Number(nowNs() - t0) / 1e6;
}
/** 测一个同步函数的稳态耗时：先热身丢弃首轮（冷），再取多轮平均。 */
function benchSteady(fn, { warmup = 1, iters = 10 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const t0 = nowNs();
  for (let i = 0; i < iters; i++) fn();
  return msSince(t0) / iters;
}

/* ================================================================== *
 * 子进程模式：仅跑合成 dsh 最坏情况（DSH_HOME 由父进程设为临时目录）
 * ================================================================== */
function runSynthChild() {
  const dsh = require('../src/dshWatcher');
  const home = process.env.DSH_HOME;
  const sessDir = path.join(home, 'sessions', '--perf--', 'session-perf-bench');
  fs.mkdirSync(sessDir, { recursive: true });
  const zstd = path.join(sessDir, 'session.jsonl.zstd');

  const seed = fs.readFileSync(SEED); // 一段合法的多帧 zstd（帧相互独立，可无限拼接）
  // 拼接种子到目标体积，构造一个「大会话」
  fs.writeFileSync(zstd, Buffer.alloc(0));
  let written = 0;
  const fd = fs.openSync(zstd, 'a');
  try {
    while (written < SYNTH_TARGET_BYTES) {
      fs.writeSync(fd, seed);
      written += seed.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  const fileMB = fs.statSync(zstd).size / 1024 / 1024;

  const scan = () => dsh.scanDshSessions({ activeWithinMs: 0, now: Date.now(), dshServerAlive: true });

  // 冷启动（首轮，尾部窗口有界解压）
  const t0 = nowNs();
  const first = scan();
  const coldMs = msSince(t0);

  // 稳态（无变化，复用累积状态，应接近 0）
  const steadyMs = benchSteady(scan, { warmup: 0, iters: 20 });

  // 活跃增量：每轮追加一段新帧（模拟会话正在写入），再扫描——直接复现卡顿事故场景
  let incTotal = 0;
  const incRounds = 15;
  const afd = fs.openSync(zstd, 'a');
  try {
    for (let i = 0; i < incRounds; i++) {
      fs.writeSync(afd, seed); // 追加 ~11KB 新帧（比真实每轮的几帧更重，偏保守）
      const t = nowNs();
      scan();
      incTotal += msSince(t);
    }
  } finally {
    fs.closeSync(afd);
  }
  const incrementMs = incTotal / incRounds;

  process.stdout.write(
    JSON.stringify({
      fileMB: Number(fileMB.toFixed(2)),
      sessions: first.length,
      coldMs: Number(coldMs.toFixed(1)),
      steadyMs: Number(steadyMs.toFixed(3)),
      incrementMs: Number(incrementMs.toFixed(3)),
    })
  );
}

/* ================================================================== *
 * 主进程模式：真实数据基准 + 派生子进程跑合成 dsh
 * ================================================================== */
function fmt(ms) {
  return ms >= 1 ? ms.toFixed(1) + 'ms' : ms.toFixed(3) + 'ms';
}

function runRealData() {
  const rows = [];
  const HOME = os.homedir();

  // Kiro（传 windowContext:null 以镜像 poll 热路径：窗口上下文在生产中是预读缓存，不在轮询里 spawn sqlite3）
  try {
    const { scanSessions } = require('../src/watcher');
    const scan = () => scanSessions({ activeWithinMs: 0, windowContext: null, kiroRunning: true });
    const first = scan();
    const steady = benchSteady(scan, { iters: 10 });
    rows.push({ name: 'Kiro   稳态扫描', ms: steady, n: first.length, gate: 'steadyMsPerRound' });
  } catch (e) {
    rows.push({ name: 'Kiro   稳态扫描', skip: (e && e.message) || String(e) });
  }

  // Claude（传 claudePids 以镜像 poll 热路径：进程存活集在生产中异步预刷、不在轮询里 pgrep）
  try {
    const cc = require('../src/claudeWatcher');
    const pids = cc.getClaudePidsSync();
    const scan = () => cc.scanClaudeSessions({ activeWithinMs: 0, claudePids: pids });
    const first = scan();
    const steady = benchSteady(scan, { iters: 10 });
    rows.push({ name: 'Claude 稳态扫描', ms: steady, n: first.length, gate: 'steadyMsPerRound' });
  } catch (e) {
    rows.push({ name: 'Claude 稳态扫描', skip: (e && e.message) || String(e) });
  }

  // dsh（真实 ~/.dsh；传 dshServerAlive 以镜像 poll 热路径，不在轮询里 pgrep）
  try {
    const dsh = require('../src/dshWatcher');
    const hasDsh = fs.existsSync(path.join(dsh.DSH_HOME, 'sessions'));
    if (!hasDsh) {
      rows.push({ name: 'dsh    稳态扫描', skip: '本机无 ~/.dsh/sessions' });
    } else {
      const scan = () => dsh.scanDshSessions({ activeWithinMs: 0, dshServerAlive: true });
      const first = scan();
      const steady = benchSteady(scan, { iters: 10 });
      rows.push({ name: 'dsh    稳态扫描', ms: steady, n: first.length, gate: 'steadyMsPerRound' });
    }
  } catch (e) {
    rows.push({ name: 'dsh    稳态扫描', skip: (e && e.message) || String(e) });
  }

  return rows;
}

function runSynthParent() {
  if (!fs.existsSync(SEED)) {
    return { skip: '缺少种子 fixture: ' + SEED };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktm-perf-'));
  try {
    const out = execFileSync('node', [__filename, '--synth'], {
      env: { ...process.env, DSH_HOME: tmp },
      encoding: 'utf8',
      timeout: 60000,
    });
    return JSON.parse(out);
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function main() {
  const wantJson = process.argv.includes('--json');
  const failures = [];
  const report = { thresholds: THRESHOLDS, real: [], synth: null };

  console.log('\n=== Kiro 任务监控 · 性能基准 ===');
  console.log(`阈值: 稳态/增量 每轮 < ${THRESHOLDS.steadyMsPerRound}ms · 合成冷启动 < ${THRESHOLDS.coldMs}ms\n`);

  // A) 真实数据稳态
  console.log('— 真实数据（本机 ~/.kiro · ~/.claude · ~/.dsh）稳态扫描 —');
  const real = runRealData();
  for (const r of real) {
    if (r.skip) {
      console.log(`  ○ ${r.name}: 跳过（${r.skip}）`);
      report.real.push({ name: r.name, skipped: r.skip });
      continue;
    }
    const limit = THRESHOLDS[r.gate];
    const ok = r.ms <= limit;
    if (!ok) failures.push(`${r.name} ${fmt(r.ms)}/轮 > ${limit}ms`);
    console.log(`  ${ok ? '✓' : '✗'} ${r.name}: ${fmt(r.ms)}/轮  (会话 ${r.n})`);
    report.real.push({ name: r.name, msPerRound: r.ms, sessions: r.n, ok });
  }

  // B) dsh 合成最坏情况
  console.log('\n— dsh 合成大会话（种子拼接 ~4MB，活跃增量）—');
  const s = runSynthParent();
  report.synth = s;
  if (s.skip) {
    console.log(`  ○ 跳过（${s.skip}）`);
  } else if (s.error) {
    console.log(`  ✗ 合成基准失败: ${s.error}`);
    failures.push('合成 dsh 基准失败: ' + s.error);
  } else {
    const coldOk = s.coldMs <= THRESHOLDS.coldMs;
    const steadyOk = s.steadyMs <= THRESHOLDS.steadyMsPerRound;
    const incOk = s.incrementMs <= THRESHOLDS.incrementMsPerRound;
    if (!coldOk) failures.push(`合成冷启动 ${fmt(s.coldMs)} > ${THRESHOLDS.coldMs}ms`);
    if (!steadyOk) failures.push(`合成稳态 ${fmt(s.steadyMs)}/轮 > ${THRESHOLDS.steadyMsPerRound}ms`);
    if (!incOk) failures.push(`合成活跃增量 ${fmt(s.incrementMs)}/轮 > ${THRESHOLDS.incrementMsPerRound}ms`);
    console.log(`  文件 ${s.fileMB}MB · 会话 ${s.sessions}`);
    console.log(`  ${coldOk ? '✓' : '✗'} 冷启动(首轮):      ${fmt(s.coldMs)}`);
    console.log(`  ${steadyOk ? '✓' : '✗'} 稳态(无变化):      ${fmt(s.steadyMs)}/轮`);
    console.log(`  ${incOk ? '✓' : '✗'} 活跃增量(每轮追加): ${fmt(s.incrementMs)}/轮  ← 卡顿事故的直接回归项`);
  }

  if (wantJson) console.log('\nJSON ' + JSON.stringify(report));

  console.log('');
  if (failures.length) {
    console.log('✗ 性能基准未通过：');
    for (const f of failures) console.log('   - ' + f);
    console.log('  热路径（poll/watcher/解析）出现同步重活会拖垮整个 UI，请优化后再发版。\n');
    process.exit(1);
  }
  console.log('✓ 性能基准通过：扫描热路径足够轻量，主线程不会被同步阻塞。\n');
}

if (process.argv.includes('--synth')) {
  runSynthChild();
} else {
  main();
}

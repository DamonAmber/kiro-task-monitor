'use strict';

/**
 * 局域网只读 Web 服务：把主进程已算好的会话/用量数据，通过 HTTP + SSE 广播给
 * 同一局域网内的浏览器（手机 / 平板 / 另一台电脑），用于全屏查看监控面板。
 *
 * 设计要点：
 * - 只读：不提供重试/聚焦等写操作（那些依赖本机 macOS 辅助功能，远端浏览器做不到）。
 * - 无第三方依赖：用 Node 内置 http + SSE（Server-Sent Events，单向服务器→客户端推送，
 *   浏览器 EventSource 自带断线重连），比 WebSocket 更轻，且刚好契合"只推数据"的场景。
 * - PIN 鉴权：会话标题/工作区名可能含真实项目名，故用 6 位 PIN 登录后下发 cookie（token）。
 *   校验一律用 crypto.timingSafeEqual，避免计时侧信道。
 * - 静态资源（css/js/manifest/icon）不含用户数据，允许未登录访问；只有 `/`、`/api/state`、
 *   `/api/stream` 需要鉴权。
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEBUI_DIR = path.join(__dirname, '..', 'webui');
const COOKIE_NAME = 'ktm_auth';
const COOKIE_MAX_AGE = 30 * 24 * 3600; // 30 天免登录

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let server = null;
let opts = null; // { getPin, getToken, getSnapshot }
let boundPort = 0;
const clients = new Set(); // 活跃 SSE 响应对象集合
let heartbeat = null;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

// Wi-Fi 网卡设备名（macOS）。探测一次并缓存：undefined=未探测 / null=无。
let _wifiIface;
function wifiIface() {
  if (_wifiIface !== undefined) return _wifiIface;
  _wifiIface = null;
  if (process.platform === 'darwin') {
    try {
      const out = require('child_process').execFileSync(
        'networksetup',
        ['-listallhardwareports'],
        { encoding: 'utf8', timeout: 3000 }
      );
      // 匹配「Hardware Port: Wi-Fi」块里的「Device: enX」
      const m = out.match(/Hardware Port:\s*Wi-?Fi\s*\r?\nDevice:\s*(\w+)/i);
      if (m) _wifiIface = m[1];
    } catch {
      /* 探测失败即视为未知，不影响功能 */
    }
  }
  return _wifiIface;
}

/**
 * 返回本机所有可用于局域网访问的 IPv4 地址，附带所在网卡名与是否为 Wi-Fi。
 * 手机通常走 Wi-Fi，故 Wi-Fi 地址排最前；其余按常见私有网段顺序。
 * 无法确定"手机与哪块网卡同网段"，因此调用方应把全部地址都展示给用户自行选择。
 */
function lanIPs() {
  const wifi = wifiIface();
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        out.push({ address: ni.address, iface: name, isWifi: name === wifi });
      }
    }
  }
  const rank = (x) => {
    if (x.isWifi) return 0; // Wi-Fi 最优先（手机常连 Wi-Fi）
    const ip = x.address;
    return /^192\.168\./.test(ip) ? 2 : /^10\./.test(ip) ? 3 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 4 : 5;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

/** 定长安全比较两个字符串，避免因长度/内容差异产生计时侧信道。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    // 长度不同时也走一次固定比较，尽量抹平计时差异
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = opts && opts.getToken ? opts.getToken() : '';
  if (!token) return false;
  const c = parseCookies(req);
  return !!c[COOKIE_NAME] && safeEqual(c[COOKIE_NAME], token);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function serveStatic(res, file, contentType) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, buf, { 'Content-Type': contentType });
  });
}

function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      data += chunk;
      if (data.length > limit) {
        over = true;
        resolve('');
      }
    });
    req.on('end', () => !over && resolve(data));
    req.on('error', () => resolve(''));
  });
}

/* ------------------------------------------------------------------ *
 * 请求处理
 * ------------------------------------------------------------------ */
async function handle(req, res) {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    pathname = req.url || '/';
  }

  // —— 登录（不需要鉴权）——
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    let pin = '';
    try {
      pin = JSON.parse(body || '{}').pin || '';
    } catch {
      pin = '';
    }
    const ok = safeEqual(pin, opts.getPin());
    // 固定小延时，给暴力尝试限速（6 位 PIN 在局域网足够）
    await new Promise((r) => setTimeout(r, 400));
    if (!ok) return send(res, 401, JSON.stringify({ ok: false }), { 'Content-Type': MIME['.json'] });
    const cookie =
      `${COOKIE_NAME}=${encodeURIComponent(opts.getToken())}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`;
    return send(res, 200, JSON.stringify({ ok: true }), {
      'Content-Type': MIME['.json'],
      'Set-Cookie': cookie,
    });
  }

  // —— 静态资源（不含用户数据，无需鉴权）——
  if (
    req.method === 'GET' &&
    /\.(js|css|webmanifest|png|svg|ico)$/.test(pathname) &&
    pathname !== '/'
  ) {
    // 防目录穿越：只取文件名部分
    const safe = path.basename(pathname);
    const ext = path.extname(safe);
    return serveStatic(res, path.join(WEBUI_DIR, safe), MIME[ext] || 'application/octet-stream');
  }

  // —— 需要鉴权的接口 —— //
  if (pathname === '/api/state') {
    if (!isAuthed(req)) return send(res, 401, JSON.stringify({ ok: false, needLogin: true }), { 'Content-Type': MIME['.json'] });
    const snap = (opts.getSnapshot && opts.getSnapshot()) || {};
    return send(res, 200, JSON.stringify(snap), { 'Content-Type': MIME['.json'] });
  }

  if (pathname === '/api/stream') {
    if (!isAuthed(req)) return send(res, 401, 'unauthorized', { 'Content-Type': 'text/plain; charset=utf-8' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    // 连上即推一帧当前快照，避免等到下一次轮询才有内容
    try {
      const snap = (opts.getSnapshot && opts.getSnapshot()) || {};
      res.write(`data: ${JSON.stringify(snap)}\n\n`);
    } catch {
      /* ignore */
    }
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // —— 主页面：已登录给应用，否则给登录页 —— //
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const file = isAuthed(req) ? 'index.html' : 'login.html';
    return serveStatic(res, path.join(WEBUI_DIR, file), MIME['.html']);
  }

  send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

/**
 * 启动服务。port 被占用时自动向后尝试若干端口。
 * @returns {Promise<{port:number, ip:string, urls:string[]}>}
 */
function start(options) {
  opts = options || {};
  const basePort = Math.max(1024, Math.min(65535, Number(options.port) || 8787));

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port) => {
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          try {
            send(res, 500, 'Internal Error', { 'Content-Type': 'text/plain; charset=utf-8' });
          } catch {
            /* ignore */
          }
          console.error('[web] handler error:', e && e.message);
        });
      });

      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && attempt < 10) {
          attempt += 1;
          server.removeAllListeners();
          try {
            server.close();
          } catch {
            /* ignore */
          }
          tryListen(port + 1);
        } else {
          reject(err);
        }
      });

      server.listen(port, '0.0.0.0', () => {
        boundPort = port;
        // 心跳注释帧，保活中间设备/代理的空闲连接
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          for (const res of clients) {
            try {
              res.write(': ping\n\n');
            } catch {
              clients.delete(res);
            }
          }
        }, 25000);
        resolve(getInfo());
      });
    };
    tryListen(basePort);
  });
}

function stop() {
  return new Promise((resolve) => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    if (!server) return resolve();
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
    server = null;
    boundPort = 0;
  });
}

/** 向所有已连接客户端推送一帧数据。 */
function broadcast(payload) {
  if (!clients.size) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

function getInfo() {
  // addresses: [{ address, iface, isWifi }]，Wi-Fi 优先。端口由 port 单独给出。
  return { port: boundPort || 0, addresses: lanIPs() };
}

module.exports = { start, stop, broadcast, getInfo, lanIPs };

'use strict';

/**
 * 无依赖生成 app 图标 build/icon.png（1024×1024 RGBA）。
 * 主题：深色渐变圆角方块 + 三行“任务列表”，左侧状态点（蓝=运行/绿=完成/红=出错）。
 * electron-builder 会在 macOS 上据此自动生成 .icns。
 *   运行：node tools/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const buf = Buffer.alloc(SIZE * SIZE * 4); // RGBA

/* ---------- 基础绘制 ---------- */
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function blend(x, y, r, g, b, a) {
  if (a <= 0) return;
  x |= 0;
  y |= 0;
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const sa = clamp(a, 0, 1);
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  buf[i] = (r * sa + buf[i] * da * (1 - sa)) / oa;
  buf[i + 1] = (g * sa + buf[i + 1] * da * (1 - sa)) / oa;
  buf[i + 2] = (b * sa + buf[i + 2] * da * (1 - sa)) / oa;
  buf[i + 3] = clamp(oa * 255, 0, 255);
}

// 圆角矩形有符号距离（<0 在内部）
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(px - cx) - halfW + r;
  const dy = Math.abs(py - cy) - halfH + r;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ox, oy) - r;
}

function fillRoundRect(cx, cy, halfW, halfH, r, colorFn, alpha = 1) {
  const x0 = Math.floor(cx - halfW - 2);
  const x1 = Math.ceil(cx + halfW + 2);
  const y0 = Math.floor(cy - halfH - 2);
  const y1 = Math.ceil(cy + halfH + 2);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = sdRoundRect(x + 0.5, y + 0.5, cx, cy, halfW, halfH, r);
      const cov = clamp(0.5 - d, 0, 1); // 1px 抗锯齿
      if (cov <= 0) continue;
      const c = colorFn(x, y);
      blend(x, y, c[0], c[1], c[2], cov * alpha);
    }
  }
}

function fillCircle(cx, cy, radius, r, g, b, alpha = 1) {
  const x0 = Math.floor(cx - radius - 2);
  const x1 = Math.ceil(cx + radius + 2);
  const y0 = Math.floor(cy - radius - 2);
  const y1 = Math.ceil(cy + radius + 2);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
      const cov = clamp(0.5 - d, 0, 1);
      if (cov <= 0) continue;
      blend(x, y, r, g, b, cov * alpha);
    }
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/* ---------- 组合图案 ---------- */
const pad = 96;
const half = (SIZE - pad * 2) / 2;
const cx = SIZE / 2;
const cy = SIZE / 2;
const corner = 224;

// 背景：竖向渐变（顶部靛蓝 → 底部近黑）
const top = [76, 141, 255];
const bot = [24, 26, 39];
fillRoundRect(cx, cy, half, half, corner, (x, y) => {
  const t = clamp((y - pad) / (SIZE - pad * 2), 0, 1);
  return [
    Math.round(lerp(top[0], bot[0], t)),
    Math.round(lerp(top[1], bot[1], t)),
    Math.round(lerp(top[2], bot[2], t)),
  ];
});

// 三行任务卡片 + 状态点
const rowColors = [
  [59, 130, 246], // running 蓝
  [34, 197, 94], // done 绿
  [239, 68, 68], // failed 红
];
const barLeft = pad + 150;
const barRight = SIZE - pad - 90;
const barHalfW = (barRight - barLeft) / 2;
const barCx = (barLeft + barRight) / 2;
const barHalfH = 54;
const dotR = 46;
const rowGap = 250;
const firstY = cy - rowGap;

for (let k = 0; k < 3; k++) {
  const ry = firstY + k * rowGap;
  // 卡片底（半透明白）
  fillRoundRect(barCx, ry, barHalfW, barHalfH, barHalfH, () => [255, 255, 255], 0.16);
  // 状态点
  const c = rowColors[k];
  fillCircle(pad + 96, ry, dotR, c[0], c[1], c[2], 1);
  // 点的高光
  fillCircle(pad + 96 - 14, ry - 14, dotR * 0.4, 255, 255, 255, 0.25);
}

/* ---------- 编码 PNG ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const stride = SIZE * 4;
const raw = Buffer.alloc((stride + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (stride + 1)] = 0; // filter: none
  buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`已生成 ${outPath}  (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);

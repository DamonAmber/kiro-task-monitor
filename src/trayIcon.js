'use strict';

/**
 * 运行时生成菜单栏（托盘）图标——一个 ◐ 半填充圆（与浮窗 logo 一致）。
 *
 * 为什么在代码里画、而不是放图片文件：electron-builder.yml 的 `files` 只打包
 * main.js / preload.js / src/**​ / renderer/**​ / package.json，**不含 build/**，
 * 所以放 build/ 的 PNG 运行时不在包内。这里沿用仓库「无依赖生成 PNG」的思路
 * （见 tools/make-icon.js），把图标做成**模板图**（setTemplateImage(true)）——
 * macOS 会据此在深色菜单栏渲染成白色、浅色菜单栏渲染成黑色，自动适配。
 */

const zlib = require('zlib');

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/**
 * 画一个尺寸为 S×S 的 ◐，返回 RGBA buffer。
 * @param {number} S 边长
 * @param {{color?:number[], dot?:boolean}} opts
 *        color 字形颜色（默认黑，用于模板图）；dot=true 时在右上角叠一个红点（失败角标）
 */
function drawGlyph(S, opts = {}) {
  const color = opts.color || [0, 0, 0];
  const buf = Buffer.alloc(S * S * 4); // 透明底 RGBA
  const c = S / 2;
  const r = S * 0.38; // 外圆半径
  const strokeHalf = Math.max(S * 0.06, 0.85); // 圆环半宽
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dist = Math.hypot(px - c, py - c);
      // 圆环（整圈描边）
      const ring = clamp(0.5 - (Math.abs(dist - r) - strokeHalf), 0, 1);
      // 左半实心（圆的左半径内填满 → 组成 ◐）
      const leftFill = px <= c ? clamp(0.5 - (dist - r), 0, 1) : 0;
      const cov = Math.max(ring, leftFill);
      if (cov <= 0) continue;
      const i = (y * S + x) * 4;
      buf[i] = color[0];
      buf[i + 1] = color[1];
      buf[i + 2] = color[2];
      buf[i + 3] = clamp(cov * 255, 0, 255);
    }
  }
  // 失败角标：右上角红点（覆盖在最上层）
  if (opts.dot) {
    const dcx = S * 0.75;
    const dcy = S * 0.25;
    const dr = S * 0.22;
    const RED = [237, 66, 69];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const cov = clamp(0.5 - (Math.hypot(x + 0.5 - dcx, y + 0.5 - dcy) - dr), 0, 1);
        if (cov <= 0) continue;
        const i = (y * S + x) * 4;
        buf[i] = RED[0];
        buf[i + 1] = RED[1];
        buf[i + 2] = RED[2];
        buf[i + 3] = Math.max(buf[i + 3], clamp(cov * 255, 0, 255));
      }
    }
  }
  return buf;
}

/* ---------- 最小 PNG 编码（RGBA） ---------- */
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
function encodePNG(rgba, S) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = S * 4;
  const raw = Buffer.alloc((stride + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 生成菜单栏用的模板图标 nativeImage（18pt，含 @2x 表征，crisp on retina）。
 * 生成失败时返回空图（不影响 app 运行，只是没图标）。
 */
function makeTrayIcon(opts = {}) {
  const { nativeImage } = require('electron');
  try {
    const alert = !!opts.alert;
    // 无告警：模板图（黑+alpha），由 macOS 自适应深/浅色菜单栏；
    // 有告警：彩色图（不能用模板，否则红点会被抹成单色），字形颜色按主题手动选。
    const glyphColor = alert ? (opts.dark ? [235, 235, 235] : [45, 45, 45]) : [0, 0, 0];
    const draw = (S) => encodePNG(drawGlyph(S, { color: glyphColor, dot: alert }), S);
    const img = nativeImage.createFromBuffer(draw(18)); // 1x
    try {
      img.addRepresentation({ scaleFactor: 2, width: 18, height: 18, buffer: draw(36) });
    } catch {
      /* 加 @2x 失败也无妨，1x 仍可用 */
    }
    img.setTemplateImage(!alert);
    return img;
  } catch {
    return nativeImage.createEmpty();
  }
}

module.exports = { makeTrayIcon, drawGlyph, encodePNG };

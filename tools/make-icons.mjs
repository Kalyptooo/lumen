// Draws the app icons without any image library: a warm point of light above a thin line on black.
//   node tools/make-icons.mjs   → icon-180.png, icon-512.png, icon.svg
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const BG = [10, 10, 10], SUN = [244, 184, 86], LINE = [238, 238, 238];
const CX = 0.5, CY = 0.45, R = 0.16, LY = 0.68, LH = 0.014, LX0 = 0.29, LX1 = 0.71;

function color(x, y) {
  if (Math.hypot(x - CX, y - CY) < R) return SUN;
  const dx = x < LX0 ? LX0 - x : (x > LX1 ? x - LX1 : 0);
  if (Math.hypot(dx, y - LY) < LH) return LINE;
  return BG;
}
function png(size) {
  const ss = 4, rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const acc = [0, 0, 0];
      for (let j = 0; j < ss; j += 1) for (let i = 0; i < ss; i += 1) {
        const c = color((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      for (let k = 0; k < 3; k += 1) row[1 + x * 3 + k] = Math.round(acc[k] / (ss * ss));
    }
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(dir, 'icon-180.png'), png(180));
fs.writeFileSync(path.join(dir, 'icon-512.png'), png(512));

const rgb = (c) => `rgb(${c.join(',')})`;
fs.writeFileSync(path.join(dir, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="22" fill="${rgb(BG)}"/>
<circle cx="${CX * 100}" cy="${CY * 100}" r="${R * 100}" fill="${rgb(SUN)}"/>
<line x1="${LX0 * 100}" y1="${LY * 100}" x2="${LX1 * 100}" y2="${LY * 100}" stroke="${rgb(LINE)}" stroke-width="${LH * 200}" stroke-linecap="round"/>
</svg>
`);
console.log('icons written');

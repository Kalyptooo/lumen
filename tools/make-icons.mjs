// Draws the app icons (a sun on the horizon) without any image library: icon-180.png, icon-512.png, icon.svg.
//   node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const BG = [15, 107, 95], FG = [242, 245, 243], SUN = [227, 178, 86];

// Shapes in a 0..1 square: sun disc above a horizon line, dotted arc of its path.
function color(x, y) {
  const cx = 0.5, cy = 0.6;
  if (y > 0.655 && y < 0.685 && x > 0.18 && x < 0.82) return FG;            // horizon
  const dSun = Math.hypot(x - cx, y - 0.5);
  if (dSun < 0.12 && y < 0.655) return SUN;                                   // sun
  const r = Math.hypot(x - cx, y - cy);
  const ang = Math.atan2(cy - y, x - cx);
  if (Math.abs(r - 0.3) < 0.014 && ang > 0.05 && ang < Math.PI - 0.05 && Math.floor(ang / 0.16) % 2 === 0) return FG; // dotted arc
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
fs.writeFileSync(path.join(dir, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="22" fill="rgb(${BG})"/>
<circle cx="50" cy="50" r="12" fill="rgb(${SUN})"/>
<rect x="18" y="65.5" width="64" height="3" rx="1.5" fill="rgb(${FG})"/>
<path d="M20 60a30 30 0 0 1 60 0" fill="none" stroke="rgb(${FG})" stroke-width="2.8" stroke-dasharray="4.8 4.8"/>
</svg>
`);
console.log('icons written');

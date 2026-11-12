// Draws the app icons without any image library: a warm light rising over an open book on a teal gradient.
//   node tools/make-icons.mjs   → icon-180.png, icon-512.png, icon.svg
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (t) => Math.max(0, Math.min(1, t));
const BG_A = [24, 132, 114], BG_B = [8, 58, 52];          // teal gradient, top left to bottom right
const SUN_A = [255, 228, 160], SUN_B = [240, 172, 66];    // warm light, centre to edge
const PAGE = [250, 246, 236], PAGE_SHADE = [222, 214, 196];

// Page edges of the open book seen from the front: low at the spine, rising, the outer corners dipping a little.
const SPINE = 0.5, LEFT = 0.16, RIGHT = 0.84;
const wing = (x) => Math.sin((Math.abs(x - SPINE) / (SPINE - LEFT)) * Math.PI * 0.75);
const pageTop = (x) => 0.66 - 0.12 * wing(x);
const pageBottom = (x) => 0.79 - 0.07 * wing(x);

function color(x, y) {
  let c = mix(BG_A, BG_B, clamp((x + y) / 2));
  // soft halo around the light
  const sx = 0.5, sy = 0.43, r = Math.hypot(x - sx, y - sy);
  const halo = clamp(1 - (r - 0.14) / 0.26);
  c = mix(c, SUN_A, 0.35 * halo * halo);
  if (r < 0.14) c = mix(SUN_A, SUN_B, clamp(r / 0.14 * 0.9 + (y - sy) * 1.2));
  // open book
  if (x > LEFT && x < RIGHT && Math.abs(x - SPINE) > 0.008 && y > pageTop(x) && y < pageBottom(x)) {
    const shade = clamp(1 - Math.abs(x - SPINE) / 0.07);
    c = mix(PAGE, PAGE_SHADE, 0.6 * shade * shade + 0.2 * clamp((y - pageTop(x)) / 0.15));
  }
  return c;
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

// SVG version for the browser tab, same shapes.
const pts = (side) => {
  const xs = [];
  for (let i = 0; i <= 12; i += 1) xs.push(side < 0 ? LEFT + (SPINE - 0.008 - LEFT) * i / 12 : SPINE + 0.008 + (RIGHT - SPINE - 0.008) * i / 12);
  const top = xs.map((x) => `${(x * 100).toFixed(2)},${(pageTop(x) * 100).toFixed(2)}`);
  const bottom = xs.slice().reverse().map((x) => `${(x * 100).toFixed(2)},${(pageBottom(x) * 100).toFixed(2)}`);
  return top.concat(bottom).join(' ');
};
const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;
fs.writeFileSync(path.join(dir, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${rgb(BG_A)}"/><stop offset="1" stop-color="${rgb(BG_B)}"/></linearGradient>
<radialGradient id="halo" cx=".5" cy=".43" r=".4"><stop offset=".35" stop-color="${rgb(SUN_A)}" stop-opacity=".4"/><stop offset="1" stop-color="${rgb(SUN_A)}" stop-opacity="0"/></radialGradient>
<radialGradient id="sun" cx=".5" cy=".38" r=".6"><stop offset="0" stop-color="${rgb(SUN_A)}"/><stop offset="1" stop-color="${rgb(SUN_B)}"/></radialGradient>
</defs>
<rect width="100" height="100" rx="22" fill="url(#bg)"/>
<rect width="100" height="100" rx="22" fill="url(#halo)"/>
<circle cx="50" cy="43" r="14" fill="url(#sun)"/>
<polygon points="${pts(-1)}" fill="${rgb(PAGE)}"/>
<polygon points="${pts(1)}" fill="${rgb(PAGE)}"/>
</svg>
`);
console.log('icons written');

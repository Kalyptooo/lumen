// Local preview of the site with a fake Firebase (tests/fake-cloud.js). Real content from data/.
//   node tests/dev-server.mjs   then   http://localhost:4174/?scene=ready&seed=1
// Scenes: signin, verify, denied, ready. admin.html?admin=1 shows the admin page; without admin=1 access is refused.
// seed=1 loads ../privat/lumen-sicherung-xaver.json (never published) as the learning state; reset=1 clears fake data.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const seedFile = path.resolve(root, '..', 'privat', 'lumen-sicherung-xaver.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.css': 'text/css' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__seed') {
    if (!fs.existsSync(seedFile)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES['.json'] });
    res.end(fs.readFileSync(seedFile));
    return;
  }
  let file = path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  let body = fs.readFileSync(file);
  const ext = path.extname(file);
  if (ext === '.html') {
    body = String(body)
      .replace(/<script src="https:\/\/www\.gstatic\.com[^"]*"><\/script>\n?/g, '')
      .replace('<script src="firebase-config.js"></script>', '<script src="tests/fake-cloud.js"></script>');
  }
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}).listen(4174, () => console.log('Lumen preview on http://localhost:4174/'));

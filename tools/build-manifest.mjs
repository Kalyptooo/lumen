// Rebuilds data/manifest.json from the files in data/. Run after adding or changing content:
//   node tools/build-manifest.mjs [data-ordner]
// The page loads the manifest first and uses `updatedAt` to bypass stale caches of the other files.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'data');
const list = (dir, re) => {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => re.test(f)).map((f) => f.replace(/\.json$/, '')).sort();
};
const DATE = /^\d{4}-\d{2}-\d{2}\.json$/;
const BATCH = /^\d{4}-\d{2}-\d{2}-\d{4}\.json$/;

const days = list('facts', DATE);
const news = list('news', DATE);
const idx = list('idx', BATCH);
const runs = list('runs', BATCH);

let reportsHandledUntil = null;
let lastRun = null;
for (const id of runs) {
  const run = JSON.parse(fs.readFileSync(path.join(root, 'runs', id + '.json'), 'utf8'));
  if (run.reportsHandledUntil && (!reportsHandledUntil || run.reportsHandledUntil > reportsHandledUntil)) reportsHandledUntil = run.reportsHandledUntil;
  if (!lastRun || String(run.at) > String(lastRun.at)) lastRun = run;
}

const manifest = {
  updatedAt: new Date().toISOString(),
  days, news, idx, runs,
  lastDate: days.length ? days[days.length - 1] : null,
  reportsHandledUntil,
  lastRun: lastRun ? { batch: lastRun.batch, at: lastRun.at, added: lastRun.added, lastDate: lastRun.lastDate, newsDate: lastRun.newsDate || null, notes: lastRun.notes || '' } : null
};
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`manifest: ${days.length} Tage (bis ${manifest.lastDate}), ${news.length} Ausgaben Aktuell, ${idx.length} Themenlisten, ${runs.length} Läufe`);

// Measures how much of the free limits Lumen uses and stores the result for the admin page (tab "Auslastung").
// Run by .github/workflows/reminders.yml after the reminders; does its work at most once an hour.
// Writes only the field `usage` of config/access (readable by admins only; no rule change needed).
// Measured:
//   - Firestore reads, writes, deletes per quota day (Cloud Monitoring; needs the role "Monitoring Viewer" for the
//     service account, otherwise the admin page explains how to grant it)
//   - stored Firestore data (estimated from the documents, once a day)
//   - size of the published website (this checkout)
//   - number of accounts (Firebase Authentication)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.FIREBASE_SA) { console.log('FIREBASE_SA fehlt: keine Auslastung gemessen.'); process.exit(0); }
const sa = JSON.parse(process.env.FIREBASE_SA);
const project = sa.project_id;
const DB = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const HOUR = 3600000, DAY = 24 * HOUR;

const b64url = (s) => Buffer.from(s).toString('base64url');
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000, scope: 'https://www.googleapis.com/auth/cloud-platform' }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` })
  });
  if (!res.ok) throw new Error('Anmeldung beim Dienstkonto fehlgeschlagen: ' + res.status);
  return (await res.json()).access_token;
}
function plain(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]));
  return v;
}
function typed(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(typed) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typed(x)])) } };
}
// The Firestore free quota resets at midnight Pacific time.
const pacificDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const viennaDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const keepLast = (list, item, n) => list.filter((x) => x && x.date !== item.date).concat([item]).slice(-n);

const token = await accessToken();
const auth = { authorization: `Bearer ${token}` };
const access = await (await fetch(`${DB}/config/access`, { headers: auth })).json();
const old = plain({ mapValue: { fields: access.fields || {} } }).usage || {};
if (old.at && Date.now() - Date.parse(old.at) < 55 * 60000 && !process.env.USAGE_FORCE) {
  console.log('Auslastung: zuletzt vor weniger als einer Stunde gemessen.');
  process.exit(0);
}
const now = Date.now();
const usage = { at: new Date(now).toISOString(), monitoring: { ok: false, error: '' }, firestore: old.firestore || null, storage: old.storage || null, site: old.site || null, accounts: old.accounts ?? null };

/* ---------- Firestore operations per quota day ---------- */
try {
  const end = new Date(Math.floor(now / (15 * 60000)) * 15 * 60000);
  const start = new Date(end.getTime() - 8 * DAY);
  const days = {};
  for (const [key, metric] of [['reads', 'read_count'], ['writes', 'write_count'], ['deletes', 'delete_count']]) {
    const q = new URLSearchParams({
      filter: `metric.type="firestore.googleapis.com/document/${metric}"`,
      'interval.startTime': start.toISOString(), 'interval.endTime': end.toISOString(),
      'aggregation.alignmentPeriod': '900s', 'aggregation.perSeriesAligner': 'ALIGN_SUM', 'aggregation.crossSeriesReducer': 'REDUCE_SUM'
    });
    const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${q}`, { headers: auth });
    const body = await res.json();
    if (!res.ok) throw new Error((body.error && (body.error.status || body.error.message)) || 'HTTP ' + res.status);
    for (const series of body.timeSeries || []) {
      for (const p of series.points || []) {
        const d = pacificDate(Date.parse(p.interval.startTime));
        days[d] = days[d] || { date: d, reads: 0, writes: 0, deletes: 0 };
        days[d][key] += Number(p.value.int64Value || p.value.doubleValue || 0);
      }
    }
  }
  const today = pacificDate(now);
  days[today] = days[today] || { date: today, reads: 0, writes: 0, deletes: 0 };
  usage.firestore = { today, days: Object.values(days).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-8) };
  usage.monitoring.ok = true;
} catch (e) {
  usage.monitoring.error = String(e.message || e).slice(0, 200);
}

/* ---------- stored data, estimated once a day ---------- */
async function listAll(url) {
  const docs = [];
  let page = '';
  do {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'pageSize=300' + (page ? '&pageToken=' + page : ''), { headers: auth });
    const body = await res.json();
    docs.push(...(body.documents || []));
    page = body.nextPageToken || '';
  } while (page);
  return docs;
}
// Rough size per Firestore's storage rules: name + fields + 32 bytes per document, about as much again for the indexes.
const sizeOf = (doc) => Buffer.byteLength(doc.name.split('/documents/')[1] || '') + Buffer.byteLength(JSON.stringify(doc.fields || {})) * 0.6 + 32;
if (!old.storage || !old.storage.at || now - Date.parse(old.storage.at) > 23 * HOUR) {
  try {
    let docs = [];
    for (const c of ['config', 'members', 'digest', 'push', 'friends']) docs = docs.concat(await listAll(`${DB}/${c}`));
    const ids = await (await fetch(`${DB}/data/users:listCollectionIds`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ pageSize: 1000 }) })).json();
    for (const uid of ids.collectionIds || []) docs = docs.concat(await listAll(`${DB}/data/users/${uid}`));
    const bytes = Math.round(docs.reduce((s, d) => s + sizeOf(d), 0) * 2);
    const item = { date: viennaDate(now), bytes };
    usage.storage = { at: usage.at, bytes, docs: docs.length, history: keepLast((old.storage && old.storage.history) || [], item, 30) };
  } catch (e) { console.log('Speicher nicht gemessen: ' + e.message); }
}

/* ---------- website size (GitHub Pages publishes this repository) ---------- */
function folderBytes(dir) {
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    sum += e.isDirectory() ? folderBytes(p) : fs.statSync(p).size;
  }
  return sum;
}
try {
  const bytes = folderBytes(process.cwd());
  usage.site = { bytes, history: keepLast((old.site && old.site.history) || [], { date: viennaDate(now), bytes }, 30) };
} catch (e) { console.log('Website nicht gemessen: ' + e.message); }

/* ---------- accounts ---------- */
try {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:query`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ returnUserInfo: false })
  });
  const body = await res.json();
  if (res.ok) usage.accounts = Number(body.recordsCount || 0);
} catch (e) { /* keep the last number */ }

const res = await fetch(`${DB}/config/access?updateMask.fieldPaths=usage`, {
  method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { usage: typed(usage) } })
});
if (!res.ok) { console.log('Auslastung nicht gespeichert: ' + res.status); process.exit(1); }
const t = usage.firestore && usage.firestore.days.find((d) => d.date === usage.firestore.today);
console.log(`Auslastung gespeichert. Lesen heute: ${t ? t.reads : '?'}${usage.monitoring.ok ? '' : ' (Monitoring: ' + usage.monitoring.error + ')'}`);

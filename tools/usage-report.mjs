// Measures how much of the free limits Lumen uses and stores the result for the admin page (tab "Auslastung").
// Run by .github/workflows/reminders.yml after the reminders; does its work at most once an hour.
// Writes the fields `usage`, `watch` and `events` of config/access (readable by admins only; no rule change needed).
// Also the hourly watcher: new sign-ups, fact reports, app errors, tight limits, facts running out and a silent weekly
// task become messages for the dashboard inbox (see tools/notify.mjs and CONNECT.md).
// Measured:
//   - Firestore reads, writes, deletes per quota day (Cloud Monitoring; needs the role "Monitoring Viewer" for the
//     service account, otherwise the admin page explains how to grant it)
//   - stored Firestore data (estimated from the documents, once a day)
//   - size of the published website (this checkout)
//   - number of accounts (Firebase Authentication)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { serviceAccount, accessToken, fieldsOf, patchFields } from './fb-rest.mjs';
import { mergeEvents } from './notify.mjs';

const sa = serviceAccount();
if (!sa) { console.log('FIREBASE_SA fehlt: keine Auslastung gemessen.'); process.exit(0); }
const project = sa.project_id;
const DB = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const HOUR = 3600000, DAY = 24 * HOUR;
const SITE = 'https://kalyptooo.github.io/lumen/', ADMIN = SITE + 'admin.html#';
// The Firestore free quota resets at midnight Pacific time.
const pacificDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const viennaDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const keepLast = (list, item, n) => list.filter((x) => x && x.date !== item.date).concat([item]).slice(-n);

const token = await accessToken(sa);
const auth = { authorization: `Bearer ${token}` };
const accessDoc = fieldsOf(await (await fetch(`${DB}/config/access`, { headers: auth })).json());
const old = accessDoc.usage || {};
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

/* ---------- watcher: turn what happened into messages for the dashboard (tools/notify.mjs) ---------- */
const U = createRequire(import.meta.url)('../lumen-usage.js');
const watch = Object.assign({}, accessDoc.watch || {});
const first = !watch.at;
const add = [];
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
try {
  const [members, digests] = await Promise.all([listAll(`${DB}/members`), listAll(`${DB}/digest`)]);
  const names = {};
  for (const d of members) { const f = fieldsOf(d); names[d.name.split('/').pop()] = f.name || f.email || 'Jemand'; }
  for (const d of digests) { const f = fieldsOf(d), uid = d.name.split('/').pop(); names[uid] = names[uid] || f.name || 'Jemand'; }

  // New sign-ups
  const newMembers = members.filter((d) => watch.membersAt && d.createTime > watch.membersAt);
  for (const d of newMembers) {
    const uid = d.name.split('/').pop();
    add.push({ key: 'member-' + uid, source: 'personen', level: 'info', title: 'Neue Anmeldung: ' + names[uid], text: 'Hat sich bei Lumen registriert.', link: ADMIN + 'people/' + uid });
  }
  // New error reports on facts
  const reports = [], errors = [];
  for (const d of digests) {
    const f = fieldsOf(d), uid = d.name.split('/').pop();
    for (const r of f.reports || []) if (r && r.reportedAt) reports.push({ ...r, uid });
    for (const e of f.errors || []) if (e && e.at) errors.push({ ...e, uid });
  }
  const newReports = reports.filter((r) => watch.reportsAt && r.reportedAt > watch.reportsAt);
  if (newReports.length) {
    const last = newReports.map((r) => r.reportedAt).sort().pop();
    add.push({ key: 'reports-' + last, source: 'meldungen', level: 'warn', title: plural(newReports.length, 'neue Fehlermeldung', 'neue Fehlermeldungen') + ' zu Fakten',
      text: newReports.slice(0, 3).map((r) => names[r.uid] + ': ' + (r.note || r.factId)).join(' · '), link: ADMIN + 'reports' });
  }
  // App errors on people's devices (index.html stores them in the person's digest)
  const newErrors = errors.filter((e) => watch.errorsAt && e.at > watch.errorsAt);
  if (newErrors.length) {
    const last = newErrors.map((e) => e.at).sort().pop();
    add.push({ key: 'errors-' + last, source: 'app', level: 'warn', title: plural(newErrors.length, 'Fehler', 'Fehler') + ' in der App',
      text: newErrors.slice(0, 3).map((e) => names[e.uid] + ': ' + e.msg + (e.where ? ' (' + e.where + ')' : '')).join(' · '), link: ADMIN + 'people/' + newErrors[0].uid });
  }
  const maxOf = (list, k, cur) => list.map((x) => x[k]).concat([cur || '']).sort().pop();
  watch.membersAt = maxOf(members, 'createTime', watch.membersAt) || new Date(now).toISOString();
  watch.reportsAt = maxOf(reports, 'reportedAt', watch.reportsAt) || new Date(now).toISOString();
  watch.errorsAt = maxOf(errors, 'at', watch.errorsAt) || new Date(now).toISOString();

  // Free limits
  const a = U.assess(usage, members.length, now);
  if (a.verdict.level !== 'ok') {
    const which = a.items.filter((i) => i.level === a.verdict.level).map((i) => i.key).join('-');
    add.push({ key: 'usage-' + a.verdict.level + '-' + which + '-' + pacificDate(now), source: 'auslastung', level: a.verdict.level, title: a.verdict.title, text: a.verdict.text, link: ADMIN + 'usage' });
  }
  if (a.lacksAccess) add.push({ key: 'usage-access', source: 'auslastung', level: 'info', title: 'Auslastung: Zahlen der Datenbank noch nicht freigegeben', text: 'Einmal freigeben, die Schritte stehen im Tab Auslastung.', link: ADMIN + 'usage' });
} catch (e) { console.log('Wächter: ' + e.message); }
try {
  const m = await (await fetch(SITE + 'data/manifest.json?t=' + now)).json();
  const t = viennaDate(now);
  const left = m.lastDate ? Math.round((Date.parse(m.lastDate) - Date.parse(t)) / DAY) : null;
  if (left !== null && left < 7) add.push({ key: 'facts-low-' + m.lastDate, source: 'fakten', level: left < 3 ? 'alert' : 'warn', title: 'Fakten reichen nur noch ' + Math.max(0, left) + ' Tage', text: 'Die Wochenaufgabe füllt sonntags auf. Läuft sie?', link: ADMIN + 'weekly' });
  const run = m.lastRun;
  if (run && run.at && now - Date.parse(run.at) > 8 * DAY) add.push({ key: 'weekly-stale-' + (run.batch || run.at), source: 'wochenaufgabe', level: 'warn', title: 'Wochenaufgabe lief seit ' + Math.floor((now - Date.parse(run.at)) / DAY) + ' Tagen nicht', text: 'Prüfe die Routine auf claude.ai.', link: ADMIN + 'weekly' });
} catch (e) { /* manifest unreachable: next hour */ }
watch.at = new Date(now).toISOString();

const save = { usage, watch };
const merged = mergeEvents(accessDoc.events, first ? add.filter((e) => /^(usage|facts|weekly)/.test(e.key)) : add, now);
if (merged.added.length) save.events = merged.events;
await patchFields(`${DB}/config/access`, auth, save);
const t = usage.firestore && usage.firestore.days.find((d) => d.date === usage.firestore.today);
console.log(`Auslastung gespeichert. Lesen heute: ${t ? t.reads : '?'}${usage.monitoring.ok ? '' : ' (Monitoring: ' + usage.monitoring.error + ')'}. Neue Meldungen: ${merged.added.length}`);

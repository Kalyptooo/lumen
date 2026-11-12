#!/usr/bin/env node
/* Lumen – Helfer für die Wochenladung: planen, prüfen, Dateien bauen und ins Archiv übernehmen.
   Keine Abhängigkeiten, Node 18+. Im GitHub-Archiv unter tools/lumen-weekly.mjs; die Inhalte liegen in data/.

   Befehle (lesen --db, Standard data, schreiben nach ./out):
     node tools/lumen-weekly.mjs today                  Datum und die nächsten Schritte
     node tools/lumen-weekly.mjs status --admin a.json  Lagebericht und Plan (out/plan.json, out/run.json)
     node tools/lumen-weekly.mjs build [draft.json …]   Entwurf prüfen (mehrere Dateien möglich), Tagesdateien und Themenliste bauen
     node tools/lumen-weekly.mjs checkfact fakt.json    einen einzelnen (korrigierten) Fakt prüfen
     node tools/lumen-weekly.mjs correct <faktId> fix.json   gemeldeten Fakt im Archiv korrigieren (Felder + "summary")
     node tools/lumen-weekly.mjs retire <faktId>         gemeldeten Fakt im Archiv zurückziehen
     node tools/lumen-weekly.mjs news [news.json]       Ausgabe „Aktuell“ prüfen und bauen
     node tools/lumen-weekly.mjs apply                  gebaute Dateien und Protokoll nach data/ übernehmen, Manifest neu bauen
     node tools/lumen-weekly.mjs check                  vorhandene Tagesdateien prüfen
   Optionen: --db <ordner> --out <ordner> --admin <datei> --today YYYY-MM-DD --fill-to YYYY-MM-DD
   --admin: Vorgaben des Admins (Firestore-Dokument config/public, wie es die REST-Schnittstelle liefert, oder schlichtes JSON). */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const TZ = 'Europe/Vienna';
export const TYPES = ['alltag', 'tech', 'erklaert', 'welt'];
export const TYPE_AREAS = {
  alltag: ['geld', 'recht', 'gesundheit', 'haushalt', 'digital', 'verkehr'],
  tech: ['tech'],
  erklaert: ['erklaert'],
  welt: ['natur', 'geschichte', 'kultur', 'denken']
};
export const TYPE_BASE = { alltag: 14, tech: 7, erklaert: 7, welt: 7 };
export const AREA_TYPE = {};
for (const t of TYPES) for (const a of TYPE_AREAS[t]) AREA_TYPE[a] = t;
export const AREA_KEYS = Object.keys(AREA_TYPE);
const BLOCK = { 1: 'morgen', 2: 'mittag', 3: 'abend', 4: 'abend', 5: 'abend' };
const NOTE_AREAS = ['recht', 'gesundheit', 'geld'];
const NOTE = 'Allgemeine Information, keine Beratung.';
// Wrong quiz options that are only a filler word are never a plausible answer.
const FILLER = /^(nie|niemals|nirgends|nichts|gar nicht|gar keine[rsn]?|keine[rsn]?)[.!]?$/i;
const NEWS_AREAS = ['recht', 'wirtschaft', 'politik', 'welt', 'tech'];
const NEWS_NOTE_AREAS = ['recht', 'wirtschaft'];
const FILL_AHEAD = 28, FILL_MAX = 21, RUN_MAX = 28, REPLACE_FROM = 3, REPLACE_DAYS = 14;
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/* ---------- Datum (immer Europe/Vienna) ---------- */

export function vienna(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const p = {};
  for (const x of f.formatToParts(now)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: (p.hour === '24' ? '00' : p.hour) + p.minute };
}
const utc = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s));
export const addDays = (d, n) => new Date(utc(d) + n * 86400000).toISOString().slice(0, 10);
export const diffDays = (a, b) => Math.round((utc(a) - utc(b)) / 86400000);
export const weekday = (d) => new Date(utc(d)).getUTCDay();
export const mondayOf = (d) => addDays(d, -((weekday(d) + 6) % 7));
export const weekIndex = (monday) => Math.round(diffDays(monday, '2026-01-05') / 7);
export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
const longDate = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${dd}. ${MONTHS[m - 1]} ${y}`; };
const mod = (n, m) => ((n % m) + m) % m;
const sum = (list) => list.reduce((a, b) => a + b, 0);
const rotate = (list, k) => { const n = mod(k, list.length); return list.slice(n).concat(list.slice(0, n)); };

/* ---------- Verteilung nach Themenauswahl ---------- */

export function normalizeWeights(weights) {
  const out = {};
  for (const a of AREA_KEYS) {
    const w = weights ? Number(weights[a]) : 1;
    out[a] = (w === 0.5 || w === 2) ? w : 1;
  }
  return out;
}
/* Größte Nachkommastellen zuerst aufrunden, Gleichstand nach Reihenfolge. */
export function largestRemainder(exact, total) {
  const base = exact.map((x) => Math.floor(x + 1e-9));
  let rest = total - sum(base);
  const order = exact.map((x, i) => ({ i, frac: Math.round((x - Math.floor(x + 1e-9)) * 1e6) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length) { base[order[k].i] += 1; rest -= 1; }
  return base;
}
/* 35 Fakten einer Woche auf die 12 Bereiche verteilen.
   Basisanteil mal Gewicht, auf 35 normiert; erst je Typ gerundet, dann je Bereich
   (so ergibt „alles normal“ genau die Tabelle: alltag 14, tech 7, erklaert 7, welt 7).
   Leitplanken: jeder Bereich mindestens 1 pro Woche, höchstens 14 (2 pro Tag). */
export function weekCounts(weights, weekIdx = 0) {
  const w = normalizeWeights(weights);
  const share = {};
  for (const t of TYPES) for (const a of TYPE_AREAS[t]) share[a] = (TYPE_BASE[t] / TYPE_AREAS[t].length) * w[a];
  const total = sum(Object.values(share));
  const exact = {};
  for (const a of AREA_KEYS) exact[a] = 35 * share[a] / total;
  const typeExact = TYPES.map((t) => sum(TYPE_AREAS[t].map((a) => exact[a])));
  const typeCount = largestRemainder(typeExact, 35);
  const counts = {};
  TYPES.forEach((t, ti) => {
    const areas = rotate(TYPE_AREAS[t], weekIdx);
    const ex = areas.map((a) => exact[a] * typeCount[ti] / typeExact[ti]);
    const c = largestRemainder(ex, typeCount[ti]);
    areas.forEach((a, i) => { counts[a] = c[i]; });
  });
  for (let guard = 0; guard < 100; guard += 1) {
    const over = AREA_KEYS.find((a) => counts[a] > 14);
    if (!over) break;
    const to = AREA_KEYS.filter((a) => counts[a] < 14).sort((x, y) => (exact[y] - counts[y]) - (exact[x] - counts[x]))[0];
    counts[over] -= 1; counts[to] += 1;
  }
  for (let guard = 0; guard < 100; guard += 1) {
    const zero = AREA_KEYS.find((a) => counts[a] === 0);
    if (!zero) break;
    const from = AREA_KEYS.filter((a) => counts[a] > 1).sort((x, y) => (counts[y] - exact[y]) - (counts[x] - exact[x]))[0];
    counts[from] -= 1; counts[zero] += 1;
  }
  return counts;
}
/* Fünf Bereiche eines Tages auf die Plätze 1–5 legen:
   Platz 1 (Morgen) bevorzugt Alltag, Platz 2 (Mittag) bevorzugt Tech. */
export function orderSlots(areas) {
  const rest = areas.slice();
  const take = (prefs) => {
    for (const t of prefs) {
      const i = rest.findIndex((a) => AREA_TYPE[a] === t);
      if (i !== -1) return rest.splice(i, 1)[0];
    }
    return rest.shift();
  };
  const s1 = take(['alltag', 'welt', 'erklaert', 'tech']);
  const s2 = take(['tech', 'erklaert', 'welt', 'alltag']);
  const s4 = take(['erklaert', 'tech', 'alltag', 'welt']);
  const s3 = take(['alltag', 'tech', 'erklaert', 'welt']);
  const s5 = take(['welt', 'alltag', 'erklaert', 'tech']);
  return [s1, s2, s3, s4, s5];
}
/* Wochenplan (Montag bis Sonntag): 7 Tage mit je 5 Bereichen.
   Die Fakten werden nach Typ und Bereich geordnet und mit Schrittweite 3 auf die
   Tage ausgeteilt: jeder Tag bekommt genau 5, ein Bereich höchstens 2 pro Tag
   (damit auch mindestens 3 verschiedene Bereiche), und die Tage eines Bereichs
   liegen über die Woche verteilt. */
export function weekPlan(monday, weights) {
  const wi = weekIndex(monday);
  const counts = weekCounts(weights, wi);
  const list = [];
  for (const t of ['tech', 'erklaert', 'alltag', 'welt']) {
    for (const a of rotate(TYPE_AREAS[t], wi)) for (let i = 0; i < counts[a]; i += 1) list.push(a);
  }
  const days = Array.from({ length: 7 }, () => []);
  const offset = mod(wi * 2, 7);
  list.forEach((a, i) => days[(offset + i * 3) % 7].push(a));
  return days.map(orderSlots);
}
/* Jeder Bereich mindestens einmal in 14 Tagen, auch über Plangrenzen hinweg.
   history: { datum: [bereiche] } der vorhandenen Tage, die bleiben. */
export function enforce14(cells, history = {}) {
  const byDate = {};
  for (const c of cells) (byDate[c.date] ||= []).push(c);
  const areasOn = (d) => (byDate[d] ? byDate[d].map((c) => c.area) : (history[d] || null));
  for (const d of Object.keys(byDate).sort()) {
    let changed = false;
    for (const area of AREA_KEYS) {
      let seen = false, complete = true;
      for (let k = 0; k < 14 && !seen; k += 1) {
        const list = areasOn(addDays(d, -k));
        if (list === null) { complete = false; break; }
        seen = list.includes(area);
      }
      if (seen || !complete) continue;
      const freq = {};
      for (let k = 0; k < 14; k += 1) for (const a of (areasOn(addDays(d, -k)) || [])) freq[a] = (freq[a] || 0) + 1;
      const sameType = (c) => (AREA_TYPE[c.area] === AREA_TYPE[area] ? 1 : 0);
      const victim = byDate[d].slice().sort((x, y) => sameType(y) - sameType(x) || freq[y.area] - freq[x.area] || y.slot - x.slot)
        .find((c) => freq[c.area] > 1);
      if (victim) { victim.area = area; changed = true; }
    }
    if (changed) {
      const ordered = orderSlots(byDate[d].map((c) => c.area));
      byDate[d].sort((x, y) => x.slot - y.slot).forEach((c, i) => { c.area = ordered[i]; });
    }
  }
  return cells;
}
export function planDates(dates, weights, history = {}) {
  const cells = [];
  const cache = {};
  for (const date of dates) {
    const monday = mondayOf(date);
    const plan = cache[monday] || (cache[monday] = weekPlan(monday, weights));
    plan[diffDays(date, monday)].forEach((area, i) => cells.push({ date, slot: i + 1, area }));
  }
  return enforce14(cells, history);
}

/* ---------- Textprüfung ---------- */

export const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const sentences = (s) => String(s || '').split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ„"])/).filter((x) => x.trim());
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
export const normText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'mit', 'ohne', 'von', 'vom', 'zum', 'zur', 'bei', 'beim', 'fuer', 'für', 'als', 'auf', 'aus', 'nach', 'vor', 'statt', 'wie', 'was', 'warum', 'wann', 'nicht', 'ist', 'sind', 'im', 'in', 'an', 'am', 'zu', 'vs', 'unterschied', 'gegen']);
const tokens = (s) => normText(s).split(' ').filter((t) => t.length >= 4 && !STOP.has(t));
function similar(a, b) {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return false;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / Math.min(ta.size, tb.size) >= 1 || common / (ta.size + tb.size - common) >= 0.5;
}
const isUrl = (u) => /^https?:\/\/[^\s]+$/i.test(String(u || ''));

/* Einen Fakt des Entwurfs prüfen. Liefert { errors, warnings }. */
export function validateFact(f) {
  const errors = [], warnings = [];
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!str(f.title)) errors.push('Titel fehlt');
  else if ([...f.title].length > 60) errors.push(`Titel hat ${[...f.title].length} Zeichen (höchstens 60)`);
  if (!str(f.text)) errors.push('Text fehlt');
  else {
    const n = wordCount(f.text);
    if (n < 40 || n > 80) errors.push(`Text hat ${n} Wörter (40 bis 80)`);
    const long = sentences(f.text).map(wordCount).filter((x) => x >= 25);
    if (long.length) warnings.push(`Satz mit ${Math.max(...long)} Wörtern (Ziel: unter 25)`);
    if (/\d\s?(€|Euro|Prozent|%)/.test(f.text) && !/Stand \d{4}/.test(f.text)) warnings.push('enthält Betrag oder Prozentwert ohne „Stand <Jahr>“: Zeitlosigkeit prüfen');
  }
  if (f.mnemonic !== undefined && f.mnemonic !== null && f.mnemonic !== '') {
    if (typeof f.mnemonic !== 'string') errors.push('Merksatz ist kein Text');
    else if (wordCount(f.mnemonic) > 15) errors.push(`Merksatz hat ${wordCount(f.mnemonic)} Wörter (höchstens 15)`);
  }
  if (!str(f.kw)) errors.push('Schlagwort (kw) fehlt');
  else if (wordCount(f.kw) > 6 || f.kw.length > 60) errors.push('Schlagwort (kw) zu lang (höchstens 6 Wörter, 60 Zeichen)');
  const q = f.quiz;
  if (!q || typeof q !== 'object') errors.push('Quiz fehlt');
  else {
    if (!str(q.question)) errors.push('Quizfrage fehlt');
    if (!Array.isArray(q.options) || q.options.length !== 4) errors.push('Quiz braucht genau 4 Optionen');
    else {
      if (!q.options.every(str)) errors.push('Quiz: leere Option');
      if (new Set(q.options.map((o) => normText(o))).size !== 4) errors.push('Quiz: Optionen nicht eindeutig');
      if (q.options.every(str) && Number.isInteger(q.correct) && q.correct >= 0 && q.correct <= 3) {
        const wrong = q.options.filter((o, i) => i !== q.correct);
        const filler = wrong.find((o) => FILLER.test(o.trim()));
        if (filler) warnings.push(`Quiz: Option „${filler.trim()}“ ist ein Füller. Falsche Antworten müssen plausibel sein`);
        const right = q.options[q.correct].trim().length;
        if (right >= 30 && right > 1.8 * Math.max(...wrong.map((o) => o.trim().length))) {
          warnings.push('Quiz: Die richtige Antwort ist deutlich länger als die falschen. Alle Optionen ähnlich lang formulieren');
        }
      }
    }
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) errors.push('Quiz: correct muss 0 bis 3 sein');
    if (!str(q.explanation)) errors.push('Quiz: Erklärung fehlt');
    else if (sentences(q.explanation).length > 1) warnings.push('Quiz: Erklärung hat mehr als einen Satz');
  }
  const all = [f.title, f.text, f.mnemonic, q && q.question, q && q.explanation].concat((q && Array.isArray(q.options)) ? q.options : []).join(' ');
  if (EMOJI.test(all)) errors.push('Emoji im Text');
  return { errors, warnings };
}

/* Position der richtigen Antwort gleichmäßig über 0–3 verteilen (deterministisch je Batch). */
export function spreadCorrect(facts, seedText) {
  let seed = 2166136261;
  for (const ch of String(seedText)) seed = Math.imul(seed ^ ch.codePointAt(0), 16777619) >>> 0;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const targets = [];
  while (targets.length < facts.length) {
    const group = [0, 1, 2, 3];
    for (let i = 3; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [group[i], group[j]] = [group[j], group[i]]; }
    if (targets.length && group[0] === targets[targets.length - 1]) [group[0], group[1]] = [group[1], group[0]];
    targets.push(...group);
  }
  facts.forEach((f, i) => {
    const options = f.quiz.options.slice();
    const right = options.splice(f.quiz.correct, 1)[0];
    options.splice(targets[i], 0, right);
    f.quiz = { question: f.quiz.question, options, correct: targets[i], explanation: f.quiz.explanation };
  });
  return facts;
}

/* ---------- Datenbank-Abzug lesen ---------- */

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => {
    try { return { id: n.slice(0, -5), data: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }; }
    catch (e) { return { id: n.slice(0, -5), data: null, error: String(e.message) }; }
  }).filter((d) => d.data && typeof d.data === 'object');
}
export const itemsOf = (dayDoc) => Object.values((dayDoc && dayDoc.items) || {}).filter((f) => f && f.id).sort((a, b) => a.slot - b.slot);
export function mergeIdx(idxDocs) {
  const out = {};
  for (const doc of idxDocs.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const [area, map] of Object.entries((doc.data && doc.data.topics) || {})) {
      for (const [id, kw] of Object.entries(map || {})) out[id] = { area, kw: String(kw) };
    }
  }
  return out;
}
// Converts a Firestore REST value ({stringValue: …}, {mapValue: {fields}}, …) to plain JSON.
export function fromFirestore(v) {
  if (!v || typeof v !== 'object') return v;
  if ('fields' in v && !('mapValue' in v)) return fromFirestore({ mapValue: v });
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestore);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFirestore(x)]));
  return v;
}
export function loadAdmin(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.error) return null;
    return raw && raw.fields ? fromFirestore(raw) : raw;
  } catch (e) { return null; }
}
export function loadDb(dbDir, adminFile) {
  const facts = readDir(path.join(dbDir, 'facts')).filter((d) => isDate(d.id));
  const runs = readDir(path.join(dbDir, 'runs')).sort((a, b) => String(a.data.at || a.id) < String(b.data.at || b.id) ? 1 : -1);
  const admin = loadAdmin(adminFile);
  // The admin's settings (config/public) take the place of the former per-user digest.
  const digests = admin ? [{ id: 'u_admin', data: admin }] : readDir(path.join(dbDir, 'digest'));
  const idx = mergeIdx(readDir(path.join(dbDir, 'idx')));
  const news = readDir(path.join(dbDir, 'news')).filter((d) => isDate(d.id)).sort((a, b) => (a.id < b.id ? 1 : -1));
  const answers = readDir(path.join(dbDir, 'answers'));
  return { facts, runs, digests, idx, news, answers };
}

/* ---------- Lage und Plan ---------- */

export function makeStatus(db, opts = {}) {
  const now = opts.now || new Date();
  const v = vienna(now);
  const today = opts.today || v.date;
  const batch = `${today}-${v.hhmm}`;
  const dayAreas = {};
  for (const d of db.facts) dayAreas[d.id] = itemsOf(d.data).map((f) => f.area);
  const dates = Object.keys(dayAreas).filter((d) => dayAreas[d].length > 0).sort();
  const lastDate = dates.length ? dates[dates.length - 1] : null;
  const incomplete = dates.filter((d) => dayAreas[d].length !== 5);

  const real = db.digests.filter((d) => d.id.startsWith('u_'));
  const pool = (real.length ? real : db.digests).slice().sort((a, b) => String(a.data.updatedAt || '') < String(b.data.updatedAt || '') ? 1 : -1);
  const main = pool[0] ? pool[0].data : {};
  const weights = normalizeWeights(main.areaWeights);
  const lastRun = db.runs[0] ? db.runs[0].data : {};
  const carry = (field) => { const r = db.runs.find((x) => x.data[field]); return r ? r.data[field] : null; };
  const appliedSettingsAt = carry('appliedSettingsAt');
  const reportsHandledUntil = carry('reportsHandledUntil');
  const settingsChangedAt = main.settingsChangedAt || null;

  const target = opts.fillTo || addDays(today, FILL_AHEAD);
  let start = lastDate && lastDate >= today ? addDays(lastDate, 1) : today;
  if (lastDate && lastDate < today && dayAreas[today]) start = addDays(today, 1);
  let fill = start <= target ? dateRange(start, target) : [];
  if (!opts.fillTo) fill = fill.slice(0, FILL_MAX);

  let replace = [];
  const needReplace = !!settingsChangedAt && (!appliedSettingsAt || settingsChangedAt > appliedSettingsAt);
  if (needReplace && lastDate) {
    const from = addDays(today, REPLACE_FROM);
    const to = [addDays(today, REPLACE_FROM + REPLACE_DAYS - 1), lastDate].sort()[0];
    replace = dateRange(from, to).filter((d) => dayAreas[d]).slice(0, Math.max(0, RUN_MAX - fill.length));
  }
  const planned = replace.concat(fill).sort();
  const history = {};
  for (const d of Object.keys(dayAreas)) if (!planned.includes(d)) history[d] = dayAreas[d];
  const cells = planDates(planned, weights, history);

  const reports = [], research = [];
  for (const d of db.digests) {
    for (const r of (Array.isArray(d.data.reports) ? d.data.reports : [])) if (r && r.factId && r.reportedAt) reports.push({ ...r, uid: d.id });
    for (const r of (Array.isArray(d.data.research) ? d.data.research : [])) if (r && r.id && r.question) research.push({ ...r, uid: d.id });
  }
  const answered = new Set(db.answers.map((a) => a.id));
  const openReports = reports.filter((r) => !reportsHandledUntil || r.reportedAt > reportsHandledUntil)
    .sort((a, b) => (a.reportedAt < b.reportedAt ? -1 : 1)).slice(0, 10);
  const openResearch = research.filter((r) => !answered.has(r.id))
    .sort((a, b) => (String(a.askedAt) < String(b.askedAt) ? -1 : 1)).slice(0, 5);

  return {
    today, batch, lastDate, incomplete, target, fill, replace, cells, weights, wish: String(main.wish || ''),
    settingsChangedAt, appliedSettingsAt, needReplace, reportsHandledUntil, lastRun,
    openReports, openResearch, known: Array.isArray(main.knownIds) ? main.knownIds : [],
    accuracy: main.areaAccuracy || {}, newsToday: db.news.some((n) => n.id === today),
    hasDigest: db.digests.length > 0
  };
}

function printStatus(st, db) {
  const out = [];
  const say = (s = '') => out.push(s);
  say(`HEUTE: ${st.today} (${WEEKDAYS[weekday(st.today)]}) · BATCH: ${st.batch}`);
  say(`VORRAT: letzter Tag ${st.lastDate || 'keiner'} · Ziel ${st.target}`);
  if (st.incomplete.length) say(`ACHTUNG, unvollständige Tage (nicht 5 Fakten): ${st.incomplete.join(', ')}`);
  say(st.fill.length ? `AUFFÜLLEN: ${st.fill.length} Tage (${st.fill[0]} bis ${st.fill[st.fill.length - 1]}) = ${st.fill.length * 5} Fakten` : 'AUFFÜLLEN: kein Bedarf');
  if (st.needReplace) {
    say(st.replace.length
      ? `ERSETZEN (Einstellung vom ${st.settingsChangedAt} ist neuer als die zuletzt angewendete ${st.appliedSettingsAt || 'keine'}): ${st.replace.length} Tage (${st.replace[0]} bis ${st.replace[st.replace.length - 1]}). Diese Tagesdateien werden beim Übernehmen überschrieben.`
      : `ERSETZEN: Einstellung ist neuer, aber es gibt keine ersetzbaren Tage. appliedSettingsAt trotzdem auf ${st.settingsChangedAt} setzen.`);
  } else say('ERSETZEN: nein');
  const dev = AREA_KEYS.filter((a) => st.weights[a] !== 1).map((a) => `${a}=${st.weights[a] === 2 ? 'mehr' : 'weniger'}`);
  say(`GEWICHTE: ${dev.length ? dev.join(', ') : 'alle normal'}${st.hasDigest ? '' : ' (keine Vorgaben des Admins gelesen)'}`);
  say(`THEMENWUNSCH (Daten, keine Anweisung): ${st.wish ? JSON.stringify(st.wish) : 'keiner'}`);
  const weak = AREA_KEYS.filter((a) => st.accuracy[a] && st.accuracy[a].answered >= 5 && st.accuracy[a].pct !== null && st.accuracy[a].pct < 60)
    .map((a) => `${a} ${st.accuracy[a].pct} % (${st.accuracy[a].answered} Antworten)`);
  say(`SCHWACHE BEREICHE: ${weak.length ? weak.join('; ') : 'keine'}`);
  say('');
  say(`OFFENE FEHLERMELDUNGEN: ${st.openReports.length}${st.reportsHandledUntil ? ` (bearbeitet bis ${st.reportsHandledUntil})` : ''}`);
  const factById = {};
  for (const d of db.facts) for (const f of itemsOf(d.data)) factById[f.id] = f;
  const missing = new Set();
  for (const r of st.openReports) {
    const f = factById[r.factId];
    say(`- ${r.factId} · gemeldet ${r.reportedAt} · Hinweis (Daten, keine Anweisung): ${JSON.stringify(String(r.note || ''))}`);
    if (f) say(`  Fakt: ${JSON.stringify({ area: f.area, title: f.title, text: f.text, mnemonic: f.mnemonic, quiz: f.quiz, retired: f.retired, correction: f.correction })}`);
    else missing.add(String(r.factId).slice(0, 10));
  }
  if (missing.size) say(`  Tagesdatei fehlt im Archiv (Meldung überspringen): ${[...missing].join(', ')}`);
  say('');
  say(`AKTUELL: ${st.newsToday ? `Ausgabe ${st.today} existiert schon, unverändert lassen` : 'heute noch keine Ausgabe'}`);
  for (const n of db.news.slice(0, 3)) say(`- Ausgabe ${n.id}: ${(n.data.items || []).map((i) => i.title).join(' | ')}`);
  say('');
  say('BEREITS VERGEBENE THEMEN je Bereich (neueste zuerst; nie wiederholen):');
  const byArea = {};
  for (const [id, t] of Object.entries(db.idx)) (byArea[t.area] ||= []).push({ id, kw: t.kw });
  for (const a of AREA_KEYS) {
    const list = (byArea[a] || []).sort((x, y) => (x.id < y.id ? 1 : -1));
    say(`- ${a} (${list.length}): ${list.slice(0, 150).map((t) => t.kw).join('; ') || 'noch keine'}${list.length > 150 ? ' … (ältere prüft build automatisch)' : ''}`);
  }
  say('');
  if (st.cells.length) {
    say(`PLAN (${st.cells.length} Fakten, in plan.json): Datum: Platz Bereich`);
    const byDate = {};
    for (const c of st.cells) (byDate[c.date] ||= []).push(c);
    for (const d of Object.keys(byDate).sort()) {
      say(`${d} (${WEEKDAYS[weekday(d)]})${st.replace.includes(d) ? ' ERSETZEN' : ''}: ${byDate[d].map((c) => `${c.slot} ${c.area}`).join(' · ')}`);
    }
    say('');
    say('ENTWURF: Schreibe draft.json als JSON-Array, ein Objekt je Planzelle:');
    say('{"date":"YYYY-MM-DD","slot":1,"area":"geld","title":"…","text":"…","mnemonic":"…(optional)","kw":"Schlagwort 2–5 Wörter","quiz":{"question":"…","options":["…","…","…","…"],"correct":0,"explanation":"…"}}');
    say('Danach: node lumen.mjs build   (id, block, type, note, createdAt, batch und die Position der richtigen Antwort setzt das Skript)');
  } else say('PLAN: nichts zu erzeugen.');
  return out.join('\n');
}

/* ---------- Bauen ---------- */

export function buildFacts(plan, draft, db, versions = {}) {
  const errors = [], warnings = [];
  const key = (c) => `${c.date}-${c.slot}`;
  const cellByKey = {};
  for (const c of plan.cells) cellByKey[key(c)] = c;
  const seen = {};
  const list = Array.isArray(draft) ? draft : [];
  if (!Array.isArray(draft)) errors.push('draft.json muss ein JSON-Array sein');
  for (const f of list) {
    const k = f && key(f);
    if (!f || !cellByKey[k]) { errors.push(`${k}: nicht im Plan`); continue; }
    if (seen[k]) { errors.push(`${k}: doppelt im Entwurf`); continue; }
    seen[k] = f;
    if (f.area !== cellByKey[k].area) errors.push(`${k}: Bereich ${f.area}, im Plan steht ${cellByKey[k].area}`);
    const res = validateFact(f);
    for (const e of res.errors) errors.push(`${k}: ${e}`);
    for (const w of res.warnings) warnings.push(`${k}: ${w}`);
    if (f.area === 'erklaert' && typeof f.text === 'string') {
      const n = sentences(f.text).length;
      if (n < 3 || n > 4) warnings.push(`${k}: „Wie funktioniert das?“ hat ${n} Sätze (Ziel: drei bis vier)`);
    }
  }
  for (const c of plan.cells) if (!seen[key(c)]) errors.push(`${key(c)} (${c.area}): fehlt im Entwurf`);

  const replaced = new Set(plan.replace || []);
  const oldTitles = {}, oldKw = [];
  for (const d of db.facts) {
    if (replaced.has(d.id)) continue;
    for (const f of itemsOf(d.data)) oldTitles[normText(f.title)] = f.id;
  }
  for (const [id, t] of Object.entries(db.idx)) if (!replaced.has(id.slice(0, 10))) oldKw.push({ id, kw: t.kw, area: t.area });
  const titles = {}, kws = {};
  for (const f of list) {
    if (!f || typeof f.title !== 'string' || typeof f.kw !== 'string') continue;
    const k = key(f), t = normText(f.title), w = normText(f.kw);
    if (oldTitles[t]) errors.push(`${k}: Titel gibt es schon (${oldTitles[t]})`);
    if (titles[t]) errors.push(`${k}: gleicher Titel wie ${titles[t]}`);
    titles[t] = k;
    if (kws[w]) errors.push(`${k}: gleiches Schlagwort wie ${kws[w]}`);
    kws[w] = k;
    for (const o of oldKw) {
      if (normText(o.kw) === w) errors.push(`${k}: Thema „${f.kw}“ gibt es schon (${o.id})`);
      else if (similar(o.kw, f.kw)) warnings.push(`${k}: Thema „${f.kw}“ ähnelt „${o.kw}“ (${o.id}, ${o.area}) – nur behalten, wenn es ein anderer Aspekt ist`);
    }
    for (const g of list) {
      if (g === f || !g || typeof g.kw !== 'string' || key(g) >= k) continue;
      if (similar(g.kw, f.kw)) warnings.push(`${k}: Thema „${f.kw}“ ähnelt „${g.kw}“ (${key(g)}) im selben Entwurf`);
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  const createdAt = new Date().toISOString();
  const facts = plan.cells.map((c) => {
    const d = seen[key(c)];
    const f = {
      id: key(c), date: c.date, slot: c.slot, block: BLOCK[c.slot], type: AREA_TYPE[c.area], area: c.area,
      title: d.title.trim(), text: d.text.trim()
    };
    if (typeof d.mnemonic === 'string' && d.mnemonic.trim()) f.mnemonic = d.mnemonic.trim();
    if (NOTE_AREAS.includes(c.area)) f.note = NOTE;
    else if (typeof d.note === 'string' && d.note.trim()) f.note = d.note.trim();
    f.quiz = { question: d.quiz.question.trim(), options: d.quiz.options.map((o) => o.trim()), correct: d.quiz.correct, explanation: d.quiz.explanation.trim() };
    f.createdAt = createdAt;
    f.batch = plan.batch;
    f.kw = d.kw.trim();
    return f;
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  spreadCorrect(facts, plan.batch);

  const days = {}, topics = {};
  for (const f of facts) {
    (topics[f.area] ||= {})[f.id] = f.kw;
    const { kw, ...rest } = f;
    (days[f.date] ||= { date: f.date, batch: plan.batch, createdAt, items: {} }).items[String(f.slot)] = rest;
  }
  const idxDoc = { id: plan.batch, date: plan.today, createdAt, topics };
  const writes = [];
  for (const d of Object.keys(days).sort()) {
    const w = { op: 'set', collection: 'facts', doc_id: d, file: `facts/${d}.json` };
    if (replaced.has(d) && versions) {
      const v = versions[`facts/${d}`];
      if (Number.isInteger(v)) w.if_version = v;
      else errors.push(`facts/${d} wird ersetzt: Version fehlt. Trage sie in versions.json ein, z. B. {"facts/${d}": 1}`);
    }
    writes.push(w);
  }
  if (errors.length) return { ok: false, errors, warnings };
  writes.push({ op: 'set', collection: 'idx', doc_id: plan.batch, file: `idx/${plan.batch}.json` });
  const correct = [0, 0, 0, 0];
  for (const f of facts) correct[f.quiz.correct] += 1;
  const perArea = {};
  for (const f of facts) perArea[f.area] = (perArea[f.area] || 0) + 1;
  return { ok: true, errors, warnings, facts, days, idxDoc, writes, correct, perArea };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function report(res) {
  for (const w of res.warnings) console.log('HINWEIS  ' + w);
  for (const e of res.errors) console.log('FEHLER   ' + e);
}

/* ---------- Aktuell ---------- */

export function buildNews(input, db, today) {
  const errors = [], warnings = [];
  const items = Array.isArray(input) ? input : (input && Array.isArray(input.items) ? input.items : null);
  if (!items) return { ok: false, errors: ['news.json braucht ein Array von Meldungen (oder {"items":[…]})'], warnings };
  if (db.news.some((n) => n.id === today)) errors.push(`Ausgabe ${today} existiert schon: unverändert lassen`);
  if (items.length < 3 || items.length > 5) errors.push(`${items.length} Meldungen (3 bis 5)`);
  if (!items.some((i) => i && i.area === 'recht')) errors.push('mindestens eine Meldung im Bereich recht (Recht oder Verwaltung in Österreich)');
  const recentTitles = db.news.slice(0, 3).flatMap((n) => (n.data.items || []).map((i) => i.title));
  const out = items.map((it, n) => {
    const tag = `Meldung ${n + 1}`;
    const str = (v) => typeof v === 'string' && v.trim().length > 0;
    if (!it || typeof it !== 'object') { errors.push(`${tag}: kein Objekt`); return null; }
    if (!NEWS_AREAS.includes(it.area)) errors.push(`${tag}: area muss eines sein von ${NEWS_AREAS.join(', ')}`);
    if (!str(it.title)) errors.push(`${tag}: Titel fehlt`);
    else if ([...it.title].length > 70) errors.push(`${tag}: Titel hat ${[...it.title].length} Zeichen (höchstens 70)`);
    if (!str(it.text)) errors.push(`${tag}: Text fehlt`);
    else {
      const w = wordCount(it.text);
      if (w < 30 || w > 60) errors.push(`${tag}: Text hat ${w} Wörter (30 bis 60)`);
      if (/[„“”"»«]/.test(it.text)) warnings.push(`${tag}: Anführungszeichen im Text – keine wörtlichen Zitate aus Artikeln`);
    }
    if (!isDate(it.date)) errors.push(`${tag}: date muss YYYY-MM-DD sein (Datum des Ereignisses)`);
    else {
      if (it.date > addDays(today, 28)) errors.push(`${tag}: Datum liegt mehr als vier Wochen in der Zukunft`);
      if (it.date < addDays(today, -10) ) warnings.push(`${tag}: Ereignis liegt mehr als 10 Tage zurück`);
    }
    const upcoming = isDate(it.date) ? it.date > today : !!it.upcoming;
    if (!it.source || !str(it.source.name) || !isUrl(it.source.url)) errors.push(`${tag}: source braucht name und eine http(s)-url einer tatsächlich geöffneten Seite`);
    if (str(it.title) && recentTitles.some((t) => similar(t, it.title))) warnings.push(`${tag}: ähnelt einer Meldung der letzten drei Ausgaben – nur behalten, wenn es Neues dazu gibt`);
    if (EMOJI.test(`${it.title} ${it.text}`)) errors.push(`${tag}: Emoji im Text`);
    const item = { id: `${today}-n${n + 1}`, area: it.area, title: String(it.title || '').trim(), text: String(it.text || '').trim(), date: it.date, upcoming };
    item.source = { name: String((it.source && it.source.name) || '').trim(), url: String((it.source && it.source.url) || '').trim() };
    if (NEWS_NOTE_AREAS.includes(it.area)) item.note = `${NOTE} Stand ${longDate(today)}.`;
    return item;
  });
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, errors, warnings, doc: { date: today, createdAt: new Date().toISOString(), items: out } };
}

/* ---------- Antworten auf Recherchefragen ---------- */

export function buildAnswers(input, openResearch) {
  const errors = [], warnings = [], docs = [];
  const list = Array.isArray(input) ? input : null;
  if (!list) return { ok: false, errors: ['answers.json muss ein JSON-Array sein'], warnings, docs };
  list.forEach((a, n) => {
    const tag = `Antwort ${n + 1}${a && a.id ? ` (${a.id})` : ''}`;
    const q = a && openResearch.find((r) => r.id === a.id);
    if (!q) { errors.push(`${tag}: id gehört zu keiner offenen Frage`); return; }
    if (typeof a.answer !== 'string' || !a.answer.trim()) errors.push(`${tag}: answer fehlt`);
    else if (wordCount(a.answer) > 120) errors.push(`${tag}: ${wordCount(a.answer)} Wörter (höchstens 120)`);
    const sources = Array.isArray(a.sources) ? a.sources : [];
    if (sources.length < 1 || sources.length > 3) errors.push(`${tag}: 1 bis 3 Quellen nötig`);
    for (const s of sources) if (!s || typeof s.name !== 'string' || !s.name.trim() || !isUrl(s.url)) errors.push(`${tag}: jede Quelle braucht name und http(s)-url`);
    docs.push({
      id: q.id, uid: q.uid, question: q.question, ref: q.ref || null, answer: String(a.answer || '').trim(),
      sources: sources.map((s) => ({ name: String((s && s.name) || '').trim(), url: String((s && s.url) || '').trim() })),
      answeredAt: new Date().toISOString()
    });
  });
  return { ok: errors.length === 0, errors, warnings, docs };
}

/* ---------- vorhandene Tage prüfen ---------- */

export function checkDays(db, weights) {
  const errors = [], warnings = [];
  const correct = [0, 0, 0, 0];
  const perArea = {};
  const dates = db.facts.map((d) => d.id).sort();
  for (const d of db.facts) {
    const items = itemsOf(d.data);
    if (items.length !== 5) errors.push(`${d.id}: ${items.length} Fakten statt 5`);
    if (d.data.date !== d.id) errors.push(`${d.id}: Feld date passt nicht zum Dokumentnamen`);
    const areas = {};
    for (const f of items) {
      const k = f.id;
      for (const field of ['id', 'date', 'slot', 'block', 'type', 'area', 'title', 'text', 'quiz', 'createdAt', 'batch']) {
        if (f[field] === undefined || f[field] === null || f[field] === '') errors.push(`${k}: Feld ${field} fehlt`);
      }
      if (f.id !== `${d.id}-${f.slot}`) errors.push(`${k}: id passt nicht zu Datum und Platz`);
      if (f.block !== BLOCK[f.slot]) errors.push(`${k}: block ${f.block} passt nicht zu Platz ${f.slot}`);
      if (AREA_TYPE[f.area] !== f.type) errors.push(`${k}: type ${f.type} passt nicht zum Bereich ${f.area}`);
      if (NOTE_AREAS.includes(f.area) && !f.note) errors.push(`${k}: Hinweis (note) fehlt`);
      const res = validateFact({ ...f, kw: 'x' });
      for (const e of res.errors) errors.push(`${k}: ${e}`);
      for (const w of res.warnings) warnings.push(`${k}: ${w}`);
      areas[f.area] = (areas[f.area] || 0) + 1;
      perArea[f.area] = (perArea[f.area] || 0) + 1;
      if (f.quiz && Number.isInteger(f.quiz.correct)) correct[f.quiz.correct] += 1;
    }
    if (Object.values(areas).some((n) => n > 2)) errors.push(`${d.id}: ein Bereich kommt mehr als zweimal vor`);
    if (Object.keys(areas).length < 3 && items.length === 5) errors.push(`${d.id}: weniger als 3 verschiedene Bereiche`);
  }
  for (let i = 1; i < dates.length; i += 1) if (diffDays(dates[i], dates[i - 1]) !== 1) warnings.push(`Lücke zwischen ${dates[i - 1]} und ${dates[i]}`);
  const dayAreas = {};
  for (const d of db.facts) dayAreas[d.id] = itemsOf(d.data).map((f) => f.area);
  for (let i = 13; i < dates.length; i += 1) {
    const win = dates.slice(i - 13, i + 1);
    if (diffDays(win[13], win[0]) !== 13) continue;
    for (const a of AREA_KEYS) if (!win.some((d) => dayAreas[d].includes(a))) errors.push(`${a}: kommt in den 14 Tagen bis ${dates[i]} nicht vor`);
  }
  if (weights) {
    const expected = planDates(dates, weights, {});
    const want = {};
    for (const c of expected) want[c.area] = (want[c.area] || 0) + 1;
    for (const a of AREA_KEYS) if ((want[a] || 0) !== (perArea[a] || 0)) warnings.push(`Verteilung ${a}: ${perArea[a] || 0} vorhanden, ${want[a] || 0} laut Plan mit diesen Gewichten`);
  }
  const total = sum(correct);
  if (total >= 20 && (Math.max(...correct) - Math.min(...correct)) > Math.max(2, total * 0.1)) errors.push(`Position der richtigen Antwort ungleich verteilt: ${correct.join('/')}`);
  return { ok: errors.length === 0, errors, warnings, correct, perArea, days: dates.length };
}

/* ---------- Kommandozeile ---------- */

function main(argv) {
  const cmd = argv[0];
  const opt = {};
  const rest = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i += 1; } else rest.push(argv[i]);
  }
  const dbDir = opt.db || 'data';
  const outDir = opt.out || './out';
  const planFile = path.join(outDir, 'plan.json');
  const runFile = path.join(outDir, 'run.json');
  const v = vienna();
  const today = opt.today || v.date;
  const here = path.dirname(fileURLToPath(import.meta.url));

  if (cmd === 'today') {
    console.log(`HEUTE=${today} UHRZEIT=${v.hhmm.slice(0, 2)}:${v.hhmm.slice(2)} (Europe/Vienna)`);
    console.log('Die Inhalte liegen in data/ (facts, idx, runs, news). Hole jetzt die Vorgaben des Admins:');
    console.log('  curl -s "https://firestore.googleapis.com/v1/projects/lumen-f76be/databases/(default)/documents/config/public" > out-admin.json');
    console.log('Danach: node tools/lumen-weekly.mjs status --admin out-admin.json');
    return 0;
  }
  if (cmd === 'checkfact') {
    if (!rest[0] || !fs.existsSync(rest[0])) { console.log('Aufruf: node tools/lumen-weekly.mjs checkfact fakt.json (Felder title, text, mnemonic, quiz)'); return 1; }
    const res = validateFact({ kw: 'x', ...JSON.parse(fs.readFileSync(rest[0], 'utf8')) });
    report(res);
    console.log(res.errors.length ? `${res.errors.length} Fehler` : 'OK');
    return res.errors.length ? 1 : 0;
  }
  if (cmd === 'correct' || cmd === 'retire') {
    const id = rest[0];
    if (!/^\d{4}-\d{2}-\d{2}-[1-5]$/.test(String(id))) { console.log(`Aufruf: node tools/lumen-weekly.mjs ${cmd} <faktId>${cmd === 'correct' ? ' fix.json' : ''}`); return 1; }
    const file = path.join(dbDir, 'facts', `${id.slice(0, 10)}.json`);
    if (!fs.existsSync(file)) { console.log(`Tagesdatei ${file} fehlt.`); return 1; }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const item = doc.items && doc.items[id.slice(11)];
    if (!item || item.id !== id) { console.log(`Fakt ${id} nicht gefunden.`); return 1; }
    if (cmd === 'retire') item.retired = true;
    else {
      if (!rest[1] || !fs.existsSync(rest[1])) { console.log('fix.json fehlt (geänderte Felder title, text, mnemonic, quiz und "summary").'); return 1; }
      const fix = JSON.parse(fs.readFileSync(rest[1], 'utf8'));
      const summary = String(fix.summary || '').trim();
      if (!summary) { console.log('In fix.json fehlt "summary": ein Satz, was geändert wurde.'); return 1; }
      const next = { ...item };
      for (const k of ['title', 'text', 'mnemonic', 'quiz', 'note']) if (fix[k] !== undefined) next[k] = fix[k];
      const res = validateFact({ kw: 'x', ...next });
      report(res);
      if (res.errors.length) { console.log(`${res.errors.length} Fehler: Es wurde nichts geändert.`); return 1; }
      next.correction = { at: new Date().toISOString(), summary: summary.slice(0, 200) };
      doc.items[id.slice(11)] = next;
    }
    fs.writeFileSync(file, JSON.stringify(doc) + '\n');
    console.log(`OK: ${id} ${cmd === 'retire' ? 'zurückgezogen' : 'korrigiert'} in ${file}.`);
    return 0;
  }
  if (cmd === 'apply') {
    if (!fs.existsSync(runFile)) { console.log('out/run.json fehlt: zuerst status ausführen.'); return 1; }
    let copied = 0;
    for (const dir of ['facts', 'idx', 'news']) {
      const src = path.join(outDir, dir);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.join(dbDir, dir), { recursive: true });
      for (const n of fs.readdirSync(src).filter((x) => x.endsWith('.json'))) {
        fs.writeFileSync(path.join(dbDir, dir, n), JSON.stringify(JSON.parse(fs.readFileSync(path.join(src, n), 'utf8'))) + '\n');
        copied += 1;
      }
    }
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    fs.mkdirSync(path.join(dbDir, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'runs', `${run.batch}.json`), JSON.stringify(run, null, 1) + '\n');
    execFileSync(process.execPath, [path.join(here, 'build-manifest.mjs'), dbDir], { stdio: 'inherit' });
    console.log(`OK: ${copied} Dateien übernommen, Protokoll runs/${run.batch}.json geschrieben.`);
    console.log('Jetzt: git add data && git commit -m "Wochenladung ' + run.date + '" && git push origin HEAD:main');
    return 0;
  }
  const db = loadDb(dbDir, opt.admin);
  if (cmd === 'status') {
    if (!opt.admin) console.log('HINWEIS  Ohne --admin gelten überall normale Gewichte, kein Themenwunsch und keine Fehlermeldungen.');
    else if (!db.digests.length) console.log('HINWEIS  Die Vorgaben des Admins ließen sich nicht lesen (Datei leer oder Fehler). Es gelten die Standardwerte.');
    const st = makeStatus(db, { today: opt.today, fillTo: opt['fill-to'] });
    writeJson(planFile, {
      today: st.today, batch: st.batch, fill: st.fill, replace: st.replace, cells: st.cells, weights: st.weights,
      settingsChangedAt: st.settingsChangedAt, appliedSettingsAt: st.appliedSettingsAt, needReplace: st.needReplace,
      reportsHandledUntil: st.reportsHandledUntil, lastDate: st.lastDate, openReports: st.openReports
    });
    if (!fs.existsSync(runFile) || JSON.parse(fs.readFileSync(runFile, 'utf8')).batch !== st.batch) {
      writeJson(runFile, {
        date: st.today, at: new Date().toISOString(), batch: st.batch, added: 0, lastDate: st.lastDate, notes: '',
        appliedSettingsAt: st.appliedSettingsAt, newsDate: null, reportsHandledUntil: st.reportsHandledUntil
      });
    }
    console.log(printStatus(st, db));
    console.log(`\nPROTOKOLL: ${path.resolve(runFile).split(path.sep).join('/')}. Trage die Werte nach jedem Teil dort ein (Felder added, lastDate, appliedSettingsAt, newsDate, reportsHandledUntil, notes).`);
    return 0;
  }
  if (cmd === 'check') {
    const digest = db.digests.find((d) => d.id.startsWith('u_'));
    const res = checkDays(db, opt.weights === 'none' ? null : normalizeWeights(digest && digest.data.areaWeights));
    report(res);
    console.log(`${res.days} Tage geprüft · Bereiche ${JSON.stringify(res.perArea)} · richtige Antwort an Position 0/1/2/3: ${res.correct.join('/')}`);
    console.log(res.ok ? 'OK' : `${res.errors.length} Fehler`);
    return res.ok ? 0 : 1;
  }
  if (!fs.existsSync(planFile)) { console.log('out/plan.json fehlt: zuerst "node tools/lumen-weekly.mjs status --admin out-admin.json" ausführen.'); return 1; }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const readInput = (name) => {
    const files = rest.length ? rest : [name];
    let merged = [];
    for (const file of files) {
      if (!fs.existsSync(file)) { console.log(`${file} fehlt.`); return undefined; }
      let data;
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { console.log(`${file} ist kein gültiges JSON: ${e.message}`); return undefined; }
      if (files.length === 1) return data;
      if (!Array.isArray(data)) { console.log(`${file}: Bei mehreren Dateien muss jede ein JSON-Array sein.`); return undefined; }
      merged = merged.concat(data);
    }
    return merged;
  };
  if (cmd === 'build') {
    const draft = readInput('draft.json');
    if (draft === undefined) return 1;
    const res = buildFacts(plan, draft, db, null);
    report(res);
    if (!res.ok) { console.log(`\n${res.errors.length} Fehler: Entwurf korrigieren und build erneut ausführen. Es wurde nichts geschrieben.`); return 1; }
    for (const [d, doc] of Object.entries(res.days)) writeJson(path.join(outDir, 'facts', `${d}.json`), doc);
    writeJson(path.join(outDir, 'idx', `${plan.batch}.json`), res.idxDoc);
    const lastDate = Object.keys(res.days).sort().pop();
    console.log(`\nOK: ${res.facts.length} Fakten in ${Object.keys(res.days).length} Tagen · Bereiche ${JSON.stringify(res.perArea)} · richtige Antwort an Position 0/1/2/3: ${res.correct.join('/')}`);
    console.log('Die Tagesdateien liegen in out/facts, die Themenliste in out/idx. „apply“ übernimmt sie ins Archiv.');
    console.log(`\nProtokollwerte: added=${res.facts.length}, lastDate=${[lastDate, plan.lastDate].filter(Boolean).sort().pop()}${plan.needReplace ? `, appliedSettingsAt=${plan.settingsChangedAt}` : ''}`);
    return 0;
  }
  if (cmd === 'news') {
    const input = readInput('news.json');
    if (input === undefined) return 1;
    const res = buildNews(input, db, plan.today);
    report(res);
    if (!res.ok) { console.log(`\n${res.errors.length} Fehler: Es wurde nichts geschrieben.`); return 1; }
    writeJson(path.join(outDir, 'news', `${plan.today}.json`), res.doc);
    console.log(`\nOK: ${res.doc.items.length} Meldungen in out/news/${plan.today}.json. „apply“ übernimmt sie ins Archiv.`);
    console.log(`Protokollwert: newsDate=${plan.today}`);
    return 0;
  }
  console.log('Befehle: today | status | build | checkfact | correct | retire | news | apply | check');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

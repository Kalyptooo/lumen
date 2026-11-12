// Tests for the pure logic of Lumen. Run: node tests/logic.test.mjs
// The logic is read from the published page itself (index.html, block <script id="lumen-logic">).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadLogic() {
  const file = process.env.LUMEN_LOGIC_FILE;
  let code;
  if (file) {
    code = fs.readFileSync(file, 'utf8');
  } else {
    const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
    const m = /<script id="lumen-logic">([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw new Error('Block <script id="lumen-logic"> nicht in index.html gefunden');
    code = m[1];
  }
  const sandbox = { module: { exports: {} }, Intl, Date, Math, JSON, Object, Array, Number, String, setTimeout };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'lumen-logic.js' });
  return sandbox.module.exports;
}

const L = loadLogic();
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { failures.push({ name, e }); }
}
const eq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), msg);
const at = (iso) => new Date(iso);

/* ---------- date and time zone ---------- */

test('Winterzeit: 22:59 UTC ist 23:59 in Wien, 23:00 UTC ist schon der nächste Tag', () => {
  eq(L.viennaParts(at('2026-11-10T22:59:59Z')), { date: '2026-11-10', hour: 23, minute: 59, minutes: 1439 });
  eq(L.viennaParts(at('2026-11-10T23:00:00Z')), { date: '2026-11-11', hour: 0, minute: 0, minutes: 0 });
});
test('Sommerzeit: 21:59 UTC ist 23:59 in Wien, 22:00 UTC ist der nächste Tag', () => {
  eq(L.viennaParts(at('2026-07-01T21:59:00Z')).date, '2026-07-01');
  eq(L.viennaParts(at('2026-07-01T22:00:00Z')), { date: '2026-07-02', hour: 0, minute: 0, minutes: 0 });
});
test('heute und gestern wechseln um Mitternacht Wiener Zeit', () => {
  eq(L.todayStr(at('2026-11-10T22:59:59Z')), '2026-11-10');
  eq(L.yesterdayStr(at('2026-11-10T22:59:59Z')), '2026-11-09');
  eq(L.todayStr(at('2026-11-10T23:00:00Z')), '2026-11-11');
  eq(L.yesterdayStr(at('2026-11-10T23:00:00Z')), '2026-11-10');
  eq(L.todayStr(at('2026-12-31T23:30:00Z')), '2027-01-01');
  eq(L.yesterdayStr(at('2026-12-31T23:30:00Z')), '2026-12-31');
});
test('Umstellung auf Sommerzeit (29. März 2026): 02:00 wird übersprungen', () => {
  eq(L.viennaParts(at('2026-03-29T00:59:00Z')), { date: '2026-03-29', hour: 1, minute: 59, minutes: 119 });
  eq(L.viennaParts(at('2026-03-29T01:00:00Z')), { date: '2026-03-29', hour: 3, minute: 0, minutes: 180 });
  eq(L.addDays('2026-03-28', 1), '2026-03-29');
  eq(L.addDays('2026-03-29', 1), '2026-03-30');
  eq(L.diffDays('2026-03-30', '2026-03-28'), 2);
});
test('Umstellung auf Winterzeit (25. Oktober 2026): 02:00 gibt es zweimal', () => {
  eq(L.viennaParts(at('2026-10-25T00:59:00Z')), { date: '2026-10-25', hour: 2, minute: 59, minutes: 179 });
  eq(L.viennaParts(at('2026-10-25T01:00:00Z')), { date: '2026-10-25', hour: 2, minute: 0, minutes: 120 });
  eq(L.addDays('2026-10-24', 2), '2026-10-26');
  eq(L.diffDays('2026-10-26', '2026-10-24'), 2);
  eq(L.todayStr(at('2026-10-25T22:59:00Z')), '2026-10-25');
  eq(L.todayStr(at('2026-10-25T23:00:00Z')), '2026-10-26');
});
test('Datumsrechnung über Monats-, Jahres- und Schaltjahresgrenzen', () => {
  eq(L.addDays('2026-11-30', 1), '2026-12-01');
  eq(L.addDays('2026-12-31', 1), '2027-01-01');
  eq(L.addDays('2028-02-28', 1), '2028-02-29');
  eq(L.addDays('2026-03-01', -1), '2026-02-28');
  eq(L.diffDays('2027-01-01', '2026-12-25'), 7);
  eq(L.weekdayOf('2026-11-15'), 0);
  eq(L.weekdayOf('2026-11-10'), 2);
});
test('Uhrzeiten parsen und Datum anzeigen', () => {
  eq(L.parseTime('07:00'), 420);
  eq(L.parseTime('23:59'), 1439);
  eq(L.parseTime('24:00'), null);
  eq(L.parseTime('abc'), null);
  eq(L.formatDay('2026-11-15'), '15. Nov.');
  eq(L.formatDay('2026-01-03', { year: true }), '3. Jän. 2026');
  eq(L.formatDay('2026-11-15', { long: true }), 'Sonntag, 15. November');
  eq(L.formatDay('kaputt'), '');
  eq(L.dateOfISO('2026-11-10T23:30:00Z'), '2026-11-11');
  eq(L.dateOfISO(''), '');
});

/* ---------- stages ---------- */

const times = { morgen: '07:00', mittag: '12:00', abend: '18:00' };
function fact(date, slot, extra) {
  const block = slot === 1 ? 'morgen' : slot === 2 ? 'mittag' : 'abend';
  return Object.assign({
    id: date + '-' + slot, date, slot, block, type: 'alltag', area: 'geld', title: 'T' + slot, text: 'x',
    quiz: { question: 'Q?', options: ['a', 'b', 'c', 'd'], correct: 1, explanation: 'weil' }
  }, extra || {});
}
const dayFacts = (date) => [1, 2, 3, 4, 5].map((s) => fact(date, s));

test('Etappen öffnen zur eingestellten Uhrzeit oder per „Früher öffnen“', () => {
  eq(L.blockUnlocked('morgen', times, 419, []), false);
  eq(L.blockUnlocked('morgen', times, 420, []), true);
  eq(L.blockUnlocked('abend', times, 600, []), false);
  eq(L.blockUnlocked('abend', times, 600, ['abend']), true);
  eq(L.blockUnlocked('mittag', { mittag: '09:30' }, 570, undefined), true);
  eq(L.blockUnlocked('mittag', { mittag: 'kaputt' }, 719, undefined), false);
  eq(L.blockUnlocked('mittag', null, 720, undefined), true);
});
test('Tagesmodell: Reihenfolge der nächsten Schritte', () => {
  const today = '2026-11-10';
  const facts = dayFacts(today);
  let m = L.todayModel({ today, minutes: 400, dayFacts: facts, states: {}, days: {}, times });
  eq(m.blocks.map((b) => b.total), [1, 1, 3]);
  eq(L.nextStep(m, {}), { type: 'locked', block: 'morgen', time: '07:00' });
  m = L.todayModel({ today, minutes: 430, dayFacts: facts, states: {}, days: {}, times });
  eq(L.nextStep(m, { quiz: 4, catchup: 2 }), { type: 'quiz', count: 4 });
  eq(L.nextStep(m, { quiz: 0, catchup: 2 }), { type: 'catchup', count: 2 });
  eq(L.nextStep(m, {}), { type: 'stage', block: 'morgen' });
  const states = { [today + '-1']: { seenAt: 'x' } };
  m = L.todayModel({ today, minutes: 430, dayFacts: facts, states, days: {}, times });
  eq(L.nextStep(m, {}), { type: 'locked', block: 'mittag', time: '12:00' });
  m = L.todayModel({ today, minutes: 430, dayFacts: facts, states, days: { [today]: { unlocked: ['abend'] } }, times });
  eq(L.nextStep(m, {}), { type: 'stage', block: 'abend' });
  const all = {};
  facts.forEach((f) => { all[f.id] = { seenAt: 'x' }; });
  all[today + '-4'] = { known: true };
  m = L.todayModel({ today, minutes: 430, dayFacts: facts, states: all, days: {}, times });
  eq(m.allDone, true);
  eq(L.nextStep(m, {}), { type: 'done' });
});
test('Leere Datenbank und unvollständige Tage führen zu keinem Absturz', () => {
  const today = '2026-11-10';
  let m = L.todayModel({ today, minutes: 600, dayFacts: [], states: {}, days: {}, times: undefined });
  eq(m.hasFacts, false);
  eq(L.nextStep(m, {}), { type: 'empty' });
  m = L.todayModel({ today, minutes: 600, states: undefined, days: undefined });
  eq(L.nextStep(m, undefined), { type: 'empty' });
  const two = [fact(today, 2), fact(today, 4)];
  m = L.todayModel({ today, minutes: 800, dayFacts: two, states: {}, days: {}, times });
  eq(m.blocks.map((b) => b.total), [0, 1, 1]);
  eq(L.nextStep(m, {}), { type: 'stage', block: 'mittag' });
  m = L.todayModel({ today, minutes: 800, dayFacts: [fact(today, 1, { retired: true })], states: {}, days: {}, times });
  eq(m.hasFacts, false);
  eq(L.factsOfDayDoc(null), []);
  eq(L.factsOfDayDoc({ items: { 2: fact(today, 2), 1: fact(today, 1), x: null } }).map((f) => f.slot), [1, 2]);
  eq(L.collectState(undefined), { states: {}, days: {} });
  eq(L.collectState([{ facts: { a: { box: 1 } }, days: { d: { quizDone: true } } }, null, {}]),
    { states: { a: { box: 1 } }, days: { d: { quizDone: true } } });
});
test('Archiv zeigt heutige Fakten erst, wenn die Etappe offen ist', () => {
  const today = '2026-11-10';
  eq(L.isReleased(fact('2026-11-09', 5), today, 0, times, {}), true);
  eq(L.isReleased(fact('2026-11-11', 1), today, 1439, times, {}), false);
  eq(L.isReleased(fact(today, 3), today, 1000, times, {}), false);
  eq(L.isReleased(fact(today, 3), today, 1080, times, {}), true);
  eq(L.isReleased(fact(today, 3), today, 1000, times, { unlocked: ['abend'] }), true);
  eq(L.isReleased(null, today, 0, times, {}), false);
});

/* ---------- Leitner ---------- */

test('Nach dem Lesen: Box 0, morgen fällig', () => {
  const st = L.afterRead(undefined, '2026-11-10T07:05:00Z', '2026-11-10', 'geld');
  eq(st, { area: 'geld', seenAt: '2026-11-10T07:05:00Z', box: 0, due: '2026-11-11', correct: 0, wrong: 0, lastReviewed: null, known: false, starred: false });
  eq(L.afterRead({ starred: true }, 'n', '2026-11-10', 'tech').starred, true);
  const again = L.afterRead(st, 'später', '2026-11-20', 'geld');
  eq(again, st, 'erneutes Lesen ändert die Planung nicht');
});
test('Richtige Antworten bei Fälligkeit: Box steigt, Intervalle 3, 7, 21, 60, 180', () => {
  let st = L.afterRead(undefined, 'n', '2026-11-10', 'geld');
  let today = '2026-11-11';
  const expected = [[1, 3], [2, 7], [3, 21], [4, 60], [5, 180], [5, 180]];
  for (const [box, interval] of expected) {
    st = L.afterAnswer(st, true, today + 'T08:00:00Z', today);
    eq(st.box, box);
    eq(st.due, L.addDays(today, interval));
    today = st.due;
  }
  eq(st.correct, 6);
  eq(st.wrong, 0);
});
test('Falsche Antwort setzt immer auf Box 0, fällig morgen', () => {
  const st = { seenAt: 'x', box: 4, due: '2027-01-01', correct: 4, wrong: 0, lastReviewed: 'x' };
  const next = L.afterAnswer(st, false, '2026-11-10T08:00:00Z', '2026-11-10');
  eq(next.box, 0);
  eq(next.due, '2026-11-11');
  eq(next.wrong, 1);
  eq(next.lastReviewed, '2026-11-10T08:00:00Z');
});
test('Richtige Antwort ohne Fälligkeit ändert Box und Termin nicht', () => {
  const st = { seenAt: 'x', box: 2, due: '2026-11-20', correct: 2, wrong: 0, lastReviewed: 'x' };
  const next = L.afterAnswer(st, true, '2026-11-10T08:00:00Z', '2026-11-10');
  eq(next.box, 2);
  eq(next.due, '2026-11-20');
  eq(next.correct, 3);
  eq(next.lastReviewed, '2026-11-10T08:00:00Z');
});
test('Fälligkeit gilt als Datum ohne Uhrzeit (am Fälligkeitstag ab 00:00)', () => {
  const st = { seenAt: 'x', box: 0, due: '2026-11-11' };
  eq(L.isDue(st, '2026-11-10'), false);
  eq(L.isDue(st, '2026-11-11'), true);
  eq(L.isDue(st, '2026-12-24'), true);
  eq(L.isDue({ seenAt: 'x', due: '2026-11-01', known: true }, '2026-11-11'), false);
  eq(L.isDue({ due: '2026-11-01' }, '2026-11-11'), false);
  eq(L.isDue(undefined, '2026-11-11'), false);
  eq(L.isDue({ seenAt: 'x', due: '2026-11-01', skip: true }, '2026-11-11'), false, 'zurückgezogene Fakten sind nie fällig');
  eq(L.randomOrder({ a: { seenAt: 'x', skip: true } }, '2026-11-11'), []);
});
test('„Kenn ich schon“ zählt als gelesen, fällt aus der Wiederholung und lässt sich rückgängig machen', () => {
  const known = L.afterKnown(undefined, '2026-11-10T07:00:00Z', 'recht');
  eq(known.known, true);
  eq(L.isHandled(known), true);
  eq(L.isDue(known, '2030-01-01'), false);
  eq(L.learnedCount({ a: known }), 0);
  const back = L.afterUnknown(known, '2026-11-12');
  eq(back.known, false);
  eq(back.box, 0);
  eq(back.due, '2026-11-13');
  eq(L.learnedCount({ a: back }), 1);
  const keep = L.afterUnknown({ seenAt: 'x', known: true, box: 3, due: '2026-12-01', correct: 3, wrong: 1, lastReviewed: 'y' }, '2026-11-12');
  eq([keep.box, keep.due], [3, '2026-12-01']);
  eq(L.toggleStar(undefined, 'tech'), { area: 'tech', starred: true });
  eq(L.toggleStar({ starred: true, seenAt: 'x' }, 'tech').starred, false);
});

/* ---------- selection ---------- */

test('Quiz zum Vortag: fällig und noch nie abgefragt, älteste zuerst', () => {
  const today = '2026-11-12';
  const states = {
    '2026-11-11-1': { seenAt: 'x', box: 0, due: '2026-11-12', lastReviewed: null },
    '2026-11-11-2': { seenAt: 'x', box: 0, due: '2026-11-12', lastReviewed: null, known: true },
    '2026-11-10-1': { seenAt: 'x', box: 0, due: '2026-11-11', lastReviewed: null },
    '2026-11-09-1': { seenAt: 'x', box: 1, due: '2026-11-12', lastReviewed: '2026-11-10T08:00:00Z' },
    '2026-11-12-1': { seenAt: 'x', box: 0, due: '2026-11-13', lastReviewed: null },
    '2026-11-08-3': { starred: true }
  };
  eq(L.selectVortag(states, today), ['2026-11-10-1', '2026-11-11-1']);
  eq(L.selectRefresh(states, today, false), ['2026-11-09-1']);
  eq(L.selectRefresh(states, today, true), ['2026-11-10-1', '2026-11-09-1', '2026-11-11-1']);
  eq(L.selectVortag({}, today), []);
  eq(L.selectVortag(undefined, today), []);
});
test('Mehr als 10 offene Fragen: höchstens 10, älteste zuerst, Rest später', () => {
  const states = {};
  for (let d = 1; d <= 5; d += 1) for (let s = 1; s <= 5; s += 1) {
    const date = '2026-11-0' + d;
    states[date + '-' + s] = { seenAt: 'x', box: 0, due: L.addDays(date, 1), lastReviewed: null };
  }
  const first = L.selectVortag(states, '2026-11-20', L.quizBudget({}));
  eq(first.length, 10);
  eq(first[0], '2026-11-01-1');
  eq(first[9], '2026-11-02-5');
  eq(L.selectVortag(states, '2026-11-20').length, 25);
  eq(L.quizBudget({ quizCount: 4 }), 6);
  eq(L.quizBudget({ quizCount: 12 }), 0);
  eq(L.quizBudget({ quizDone: true }), 0);
  eq(L.selectVortag(states, '2026-11-20', L.quizBudget({ quizCount: 7 })).length, 3);
});
test('Fakten ohne gültiges Quiz werden nicht abgefragt', () => {
  eq(L.quizzable(fact('2026-11-10', 1)), true);
  eq(L.quizzable(fact('2026-11-10', 1, { quiz: undefined })), false);
  eq(L.quizzable(fact('2026-11-10', 1, { quiz: { question: 'Q', options: ['a', 'b', 'c'], correct: 0 } })), false);
  eq(L.quizzable(fact('2026-11-10', 1, { quiz: { question: 'Q', options: ['a', 'b', 'c', 'd'], correct: 4 } })), false);
  eq(L.quizzable(fact('2026-11-10', 1, { quiz: { question: '', options: ['a', 'b', 'c', 'd'], correct: 0 } })), false);
  eq(L.quizzable(fact('2026-11-10', 1, { retired: true })), false);
  eq(L.quizzable(null), false);
});
test('Nachholen: ungelesene Fakten der letzten sieben Tage, nicht heute, nichts Älteres', () => {
  const today = '2026-11-20';
  const facts = [fact('2026-11-12', 1), fact('2026-11-13', 2), fact('2026-11-19', 1), fact('2026-11-19', 3),
    fact('2026-11-19', 2, { retired: true }), fact(today, 1), fact('2026-11-18', 4)];
  const states = { '2026-11-19-3': { seenAt: 'x' }, '2026-11-18-4': { known: true } };
  eq(L.selectCatchup(facts, states, today).map((f) => f.id), ['2026-11-13-2', '2026-11-19-1']);
  eq(L.selectCatchup([], {}, today), []);
  eq(L.selectCatchup(undefined, undefined, today), []);
});

/* ---------- random mode ---------- */

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
test('Zufallsmodus: nur Gelesenes, nichts Bekanntes, kein Fakt doppelt', () => {
  const today = '2026-12-01';
  const states = {};
  for (let i = 1; i <= 30; i += 1) states['2026-10-' + String(i).padStart(2, '0') + '-1'] = { seenAt: '2026-10-05T08:00:00Z', box: 1, due: '2026-12-20' };
  states.k = { seenAt: 'x', known: true };
  states.s = { starred: true };
  const order = L.randomOrder(states, today, lcg(7));
  eq(order.length, 30);
  eq(new Set(order).size, 30);
  eq(order.includes('k'), false);
  eq(order.includes('s'), false);
  eq(L.randomOrder(states, today, lcg(7)), order, 'gleicher Zufall, gleiche Reihenfolge');
  const skip = { [order[0]]: true };
  eq(L.randomOrder(states, today, lcg(7), skip).includes(order[0]), false);
  eq(L.randomOrder({}, today, lcg(1)), []);
  eq(L.randomOrder(undefined, today), []);
});
test('Zufallsmodus bevorzugt Altes, oft Falsches und Gemerktes', () => {
  const today = '2026-12-01';
  const fresh = { seenAt: '2026-11-30T08:00:00Z', lastReviewed: '2026-11-30T08:00:00Z', correct: 3, wrong: 0 };
  const old = { seenAt: '2025-10-01T08:00:00Z', correct: 1, wrong: 0 };
  const wrong = { seenAt: '2026-11-30T08:00:00Z', lastReviewed: '2026-11-30T08:00:00Z', correct: 1, wrong: 4 };
  const star = Object.assign({}, fresh, { starred: true });
  assert.ok(L.randomWeight(old, today) > L.randomWeight(fresh, today));
  assert.ok(L.randomWeight(wrong, today) > L.randomWeight(fresh, today));
  assert.ok(L.randomWeight(star, today) > L.randomWeight(fresh, today));
  eq(L.randomWeight(undefined, today), 0);
  const states = { old, wrong, star };
  for (let i = 0; i < 12; i += 1) states['f' + i] = fresh;
  const rng = lcg(42);
  const firsts = { old: 0, wrong: 0, star: 0, fresh: 0 };
  for (let i = 0; i < 3000; i += 1) {
    const top = L.randomOrder(states, today, rng)[0];
    if (firsts[top] === undefined) firsts.fresh += 1; else firsts[top] += 1;
  }
  const perFresh = firsts.fresh / 12;
  assert.ok(firsts.old > 3 * perFresh, 'alt kommt klar häufiger: ' + JSON.stringify(firsts));
  assert.ok(firsts.wrong > 2 * perFresh, 'falsch beantwortet kommt häufiger');
  assert.ok(firsts.star > 1.5 * perFresh, 'gemerkt kommt häufiger');
});

/* ---------- streak ---------- */

test('Serie: aufeinanderfolgende Tage, offener heutiger Tag bricht sie nicht', () => {
  const days = {
    '2026-11-07': { blocksDone: ['morgen'] },
    '2026-11-08': { quizDone: true },
    '2026-11-09': { blocksDone: ['morgen', 'abend'] },
    '2026-11-05': { blocksDone: ['morgen'] }
  };
  eq(L.streak(days, '2026-11-10'), 3);
  eq(L.streak(Object.assign({ '2026-11-10': { practiced: true } }, days), '2026-11-10'), 4);
  eq(L.streak(days, '2026-11-11'), 0, 'ein verpasster Tag beendet die Serie');
  eq(L.streak({}, '2026-11-10'), 0);
  eq(L.streak(undefined, '2026-11-10'), 0);
  eq(L.streak({ '2026-11-10': { blocksDone: [] } }, '2026-11-10'), 0);
  eq(L.streak({ '2026-11-10': { unlocked: ['abend'] } }, '2026-11-10'), 0);
});
test('Serie läuft über Monats- und Zeitumstellungsgrenzen', () => {
  const days = {};
  for (let i = 0; i < 40; i += 1) days[L.addDays('2026-10-01', i)] = { blocksDone: ['morgen'] };
  eq(L.streak(days, '2026-11-09'), 40);
  eq(L.streak(days, '2026-11-10'), 40);
});
test('Zähler und Statuszeile', () => {
  const states = { a: { seenAt: 'x' }, b: { seenAt: 'x', known: true }, c: { starred: true }, d: { seenAt: 'y' } };
  eq(L.learnedCount(states), 2);
  eq(L.statusLine(12, 214), '12 Tage in Folge · 214 Fakten gelernt');
  eq(L.statusLine(1, 1), '1 Tag in Folge · 1 Fakt gelernt');
  eq(L.statusLine(0, 30), '30 Fakten gelernt');
  eq(L.statusLine(0, 0), 'Schön, dass du da bist.');
});

/* ---------- knowledge map and digest ---------- */

test('Wissenskarte: gelesene Fakten und Trefferquote der letzten 30 Antworten', () => {
  let recent = [];
  for (let i = 0; i < 40; i += 1) recent = L.pushRecent(recent, i >= 25);
  eq(recent.length, 30);
  eq(recent.filter(Boolean).length, 15);
  const states = { a: { seenAt: 'x', area: 'geld' }, b: { seenAt: 'x', area: 'geld', known: true }, c: { seenAt: 'x', area: 'tech' }, d: { starred: true, area: 'tech' } };
  const stats = { areas: { geld: { recent }, tech: { recent: [1, 1, 0, 1] } } };
  const map = L.areaStats(states, stats);
  eq(map.geld, { read: 1, answered: 30, pct: 50 });
  eq(map.tech, { read: 1, answered: 4, pct: 75 });
  eq(map.natur, { read: 0, answered: 0, pct: null });
  eq(Object.keys(map).length, 12);
  eq(L.areaStats(undefined, undefined).recht, { read: 0, answered: 0, pct: null });
});
test('Digest für die Wochenaufgabe', () => {
  const states = { '2026-11-10-1': { seenAt: '2026-11-10T08:00:00Z', known: true, area: 'geld' }, '2026-11-10-2': { seenAt: '2026-11-10T09:00:00Z', area: 'tech' } };
  const d = L.buildDigest({
    settings: { wish: 'Mehr zu Steuern', areaWeights: { geld: 2, tech: 0.5, natur: 7 }, settingsChangedAt: '2026-11-10T10:00:00Z' },
    states, stats: { areas: { tech: { recent: [1, 0] } } },
    reports: [{ factId: '2026-11-10-2', note: 'x', reportedAt: '2026-11-10T11:00:00Z' }],
    research: [], nowISO: '2026-11-10T12:00:00Z'
  });
  eq(d.wish, 'Mehr zu Steuern');
  eq(d.areaWeights.geld, 2);
  eq(d.areaWeights.tech, 0.5);
  eq(d.areaWeights.natur, 1, 'ungültige Gewichte werden zu normal');
  eq(d.areaWeights.recht, 1);
  eq(d.knownIds, ['2026-11-10-1']);
  eq(d.seenCount, 1);
  eq(d.areaAccuracy.tech, { read: 1, answered: 2, pct: 50 });
  eq(d.reports.length, 1);
  eq(d.updatedAt, '2026-11-10T12:00:00Z');
  eq(L.sameDigest(d, Object.assign({}, d, { updatedAt: 'später' })), true);
  eq(L.sameDigest(d, Object.assign({}, d, { wish: 'anders' })), false);
  eq(L.sameDigest(null, d), false);
  const empty = L.buildDigest({ nowISO: 'n' });
  eq(empty.wish, '');
  eq(empty.knownIds, []);
  eq(empty.seenCount, 0);
  eq(Object.keys(empty.areaWeights).length, 12);
});

/* ---------- Aktuell ---------- */

test('Aktuell: neueste Ausgabe, Stand, „Neu“ und „älter als 10 Tage“', () => {
  const ed = (date) => ({ date, items: [{ id: date + '-1', title: 'T' }] });
  const editions = [ed('2026-11-01'), ed('2026-11-15'), ed('2026-11-08'), ed('2026-11-22'), { date: '2026-11-16', items: [] }, null];
  let pick = L.pickNews(editions, '2026-11-17', '2026-11-08');
  eq(pick.stand, '2026-11-15', 'eine Ausgabe mit künftigem Datum bleibt unsichtbar');
  eq(pick.isNew, true);
  eq(pick.stale, false);
  eq(pick.earlier.map((e) => e.date), ['2026-11-08', '2026-11-01']);
  eq(L.newsLine(pick), 'Aktuell · Stand 15. Nov. · Neu');
  pick = L.pickNews(editions, '2026-11-17', '2026-11-15');
  eq(pick.isNew, false);
  eq(L.newsLine(pick), 'Aktuell · Stand 15. Nov.');
  eq(L.pickNews(editions, '2026-11-25', '2026-11-22').stale, false, 'genau 10 Tage ist noch nicht älter als 10 Tage … 22. bis 25. sind 3');
  eq(L.pickNews([ed('2026-11-15')], '2026-11-25', '2026-11-15').stale, false);
  pick = L.pickNews([ed('2026-11-15')], '2026-11-26', '2026-11-15');
  eq(pick.stale, true);
  eq(L.newsLine(pick), 'Aktuell · Stand 15. Nov. · älter als 10 Tage');
  eq(L.pickNews([], '2026-11-17', null), null);
  eq(L.pickNews(undefined, '2026-11-17', null), null);
  eq(L.newsLine(null), '');
  const many = [];
  for (let i = 0; i < 12; i += 1) many.push(ed(L.addDays('2026-08-02', i * 7)));
  eq(L.pickNews(many, '2026-12-01', null).earlier.length, 8, 'höchstens 8 frühere Ausgaben');
  eq(L.safeUrl('https://www.ris.bka.gv.at/x'), 'https://www.ris.bka.gv.at/x');
  eq(L.safeUrl('javascript:alert(1)'), '');
  eq(L.safeUrl(undefined), '');
});

/* ---------- reports and research ---------- */

test('Status von Fehlermeldungen', () => {
  const report = { factId: '2026-11-10-1', note: 'Zahl stimmt nicht', reportedAt: '2026-11-12T10:00:00Z' };
  const f = fact('2026-11-10', 1);
  eq(L.reportStatus(report, f, null), 'offen');
  eq(L.reportStatus(report, f, '2026-11-11T00:00:00Z'), 'offen');
  eq(L.reportStatus(report, f, '2026-11-12T10:00:00Z'), 'geprueft');
  eq(L.reportStatus(report, Object.assign({}, f, { retired: true }), '2026-11-15T10:10:00Z'), 'zurueckgezogen');
  const corrected = Object.assign({}, f, { correction: { at: '2026-11-15T10:12:00Z', summary: 'Frist berichtigt.' } });
  eq(L.reportStatus(report, corrected, '2026-11-15T10:10:00Z'), 'korrigiert');
  eq(L.reportStatusText('korrigiert', corrected), 'Korrigiert am 15. Nov. 2026');
  const oldFix = Object.assign({}, f, { correction: { at: '2026-11-01', summary: 'alt' } });
  eq(L.reportStatus(report, oldFix, '2026-11-15T10:10:00Z'), 'geprueft', 'eine ältere Korrektur zählt nicht für eine neuere Meldung');
  eq(L.reportStatus(null, f, 'x'), null);
  eq(L.reportStatusText('offen'), 'Gemeldet, wird am Sonntag geprüft');
  eq(L.reportStatusText('geprueft'), 'Geprüft, keine Änderung nötig');
  eq(L.reportStatusText('zurueckgezogen'), 'Zurückgezogen');
  const reports = [report, { factId: 'b', reportedAt: '2026-11-16T09:00:00Z' }, { factId: '2026-11-10-1', reportedAt: '2026-11-17T09:00:00Z' }];
  eq(L.openReports(reports, '2026-11-15T10:10:00Z').length, 2);
  eq(L.openReports(reports, null).length, 3);
  eq(L.latestReport(reports, '2026-11-10-1').reportedAt, '2026-11-17T09:00:00Z');
  eq(L.latestReport(reports, 'nix'), null);
});
test('Status von Recherchefragen', () => {
  const research = [{ id: 'r1', question: 'A?' }, { id: 'r2', question: 'B?' }];
  const answers = { r1: { answer: 'Ja.' } };
  eq(L.researchStatus(research[0], answers), 'beantwortet');
  eq(L.researchStatus(research[1], answers), 'wartet');
  eq(L.researchStatus(research[1], undefined), 'wartet');
  eq(L.openResearch(research, answers).map((r) => r.id), ['r2']);
  eq(L.openResearch(undefined, answers), []);
});

/* ---------- archive search ---------- */

test('Suche im Archiv', () => {
  const f = fact('2026-11-10', 1, { title: 'Zinseszins wirkt früh', text: 'Wer früh anlegt, gewinnt Zeit.', mnemonic: 'Zeit schlägt Betrag', area: 'geld' });
  eq(L.matchesQuery(f, ''), true);
  eq(L.matchesQuery(f, 'zinseszins'), true);
  eq(L.matchesQuery(f, 'FRÜH zeit'), true);
  eq(L.matchesQuery(f, 'fruh'), true, 'Umlaute werden großzügig behandelt');
  eq(L.matchesQuery(f, 'Finanzen'), true, 'der Bereichsname zählt mit');
  eq(L.matchesQuery(f, 'Mikrowelle'), false);
  const merged = L.mergeIdx([
    { id: '2026-11-15-1107', topics: { geld: { '2026-11-20-1': 'Zinseszins' }, tech: { '2026-11-20-2': 'USB-C Stecker' } } },
    { id: '2026-11-22-1107', topics: { recht: { '2026-11-20-1': 'Gewährleistung Frist' }, tech: { '2026-12-30-2': 'USB-C Kabel' } } }
  ]);
  eq(merged['2026-11-20-1'], { area: 'recht', kw: 'Gewährleistung Frist' }, 'die spätere Ladung gewinnt');
  eq(L.searchIdx(merged, 'usb', '2026-11-25'), ['2026-11-20-2'], 'künftige Fakten bleiben unsichtbar');
  eq(L.searchIdx(merged, 'us', '2026-11-25'), [], 'unter drei Zeichen keine Themensuche');
  eq(L.searchIdx(merged, 'gewahrleistung', '2026-11-25'), ['2026-11-20-1']);
  eq(L.mergeIdx(undefined), {});
});

/* ---------- haptics ---------- */

test('Haptik: Vibration, wenn der Browser sie kennt', () => {
  const calls = [];
  const tick = L.makeTick({ isEnabled: () => true, vibrate: (p) => calls.push(p), getLabel: () => { throw new Error('nicht nötig'); } });
  eq(tick('single'), true);
  eq(tick('double'), true);
  eq(calls, [10, [10, 70, 10]]);
});
test('Haptik: Schalter-Trick auf dem iPhone, Doppeltick mit zweitem Klick nach 80 ms', () => {
  let clicks = 0;
  const timers = [];
  const label = { click: () => { clicks += 1; } };
  const tick = L.makeTick({ isEnabled: () => true, getLabel: () => label, setTimeout: (fn, ms) => timers.push({ fn, ms }) });
  eq(tick('single'), true);
  eq(clicks, 1);
  eq(timers.length, 0);
  eq(tick('double'), true);
  eq(clicks, 2);
  eq(timers.map((t) => t.ms), [80]);
  timers[0].fn();
  eq(clicks, 3);
});
test('Haptik: ausgeschaltet oder ohne Unterstützung passiert nichts, nie ein Fehler', () => {
  let clicks = 0;
  const label = { click: () => { clicks += 1; } };
  eq(L.makeTick({ isEnabled: () => false, getLabel: () => label })('single'), false);
  eq(clicks, 0);
  eq(L.makeTick({ isEnabled: () => true, getLabel: () => null })('single'), false);
  eq(L.makeTick({ isEnabled: () => true })('double'), false);
  eq(L.makeTick(undefined)('single'), false);
  eq(L.makeTick({ isEnabled: () => { throw new Error('kaputt'); } })('single'), false);
  eq(L.makeTick({ isEnabled: () => true, getLabel: () => ({ click: () => { throw new Error('kaputt'); } }) })('double'), false);
  eq(L.makeTick({ isEnabled: () => true, vibrate: () => { throw new Error('kaputt'); } })('single'), false);
  const timers = [];
  let n = 0;
  const flaky = { click: () => { n += 1; if (n > 1) throw new Error('zweiter Klick scheitert'); } };
  eq(L.makeTick({ isEnabled: () => true, getLabel: () => flaky, setTimeout: (fn) => timers.push(fn) })('double'), true);
  assert.doesNotThrow(() => timers[0]());
});

/* ---------- result ---------- */

if (failures.length) {
  for (const f of failures) console.error('FEHLER  ' + f.name + '\n        ' + String(f.e && f.e.message).split('\n').join('\n        '));
  console.error('\n' + passed + ' bestanden, ' + failures.length + ' fehlgeschlagen');
  process.exit(1);
}
console.log('Logik: ' + passed + ' Tests bestanden');

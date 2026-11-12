// Tests for the weekly helper (planning, validation, building). Run: node tests/weekly.test.mjs
import assert from 'node:assert/strict';
import * as W from '../tools/lumen-weekly.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (e) { failures.push({ name, e }); }
}
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const eq = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
const sum =(o) => Object.values(o).reduce((a, b) => a + b, 0);
const typeSum = (counts, type) => W.TYPE_AREAS[type].reduce((s, a) => s + counts[a], 0);

test('Alles normal: alltag 14, tech 7, erklaert 7, welt 7 pro Woche', () => {
  for (let wi = 0; wi < 12; wi += 1) {
    const c = W.weekCounts({}, wi);
    eq(sum(c), 35);
    eq([typeSum(c, 'alltag'), typeSum(c, 'tech'), typeSum(c, 'erklaert'), typeSum(c, 'welt')], [14, 7, 7, 7]);
    for (const a of W.TYPE_AREAS.alltag) assert.ok(c[a] === 2 || c[a] === 3);
    for (const a of W.TYPE_AREAS.welt) assert.ok(c[a] === 1 || c[a] === 2);
  }
});
test('Alles normal: über 12 Wochen kommen alle Bereiche eines Typs gleich oft vor', () => {
  const total = {};
  for (let wi = 0; wi < 12; wi += 1) for (const [a, n] of Object.entries(W.weekCounts({}, wi))) total[a] = (total[a] || 0) + n;
  for (const a of W.TYPE_AREAS.alltag) eq(total[a], 28);
  for (const a of W.TYPE_AREAS.welt) eq(total[a], 21);
});
test('Gewichte verschieben die Anteile, Summe bleibt 35', () => {
  const more = W.weekCounts({ geld: 2 }, 0), normal = W.weekCounts({}, 0), less = W.weekCounts({ geld: 0.5 }, 0);
  eq(sum(more), 35); eq(sum(less), 35);
  assert.ok(more.geld > normal.geld, 'mehr');
  assert.ok(less.geld < normal.geld || less.geld === 1, 'weniger');
  const techMore = W.weekCounts({ tech: 2 }, 3);
  assert.ok(techMore.tech > 7 && techMore.tech <= 14);
  eq(W.largestRemainder([1.5, 1.5, 2], 5), [2, 1, 2]);
  eq(W.largestRemainder([2.4, 2.4, 0.2], 5), [3, 2, 0]);
});
test('Leitplanken der Woche: jeder Bereich mindestens 1, höchstens 14', () => {
  const extreme = { tech: 2 };
  for (const a of W.AREA_KEYS) if (a !== 'tech') extreme[a] = 0.5;
  for (const weights of [extreme, { natur: 0.5, geld: 2, recht: 2, gesundheit: 2, haushalt: 2, digital: 2, verkehr: 2, tech: 2, erklaert: 2, geschichte: 2, kultur: 2, denken: 2 }]) {
    for (let wi = 0; wi < 8; wi += 1) {
      const c = W.weekCounts(weights, wi);
      eq(sum(c), 35);
      for (const a of W.AREA_KEYS) assert.ok(c[a] >= 1 && c[a] <= 14, `${a}=${c[a]}`);
    }
  }
});
test('Wochenplan: 5 pro Tag, höchstens 2 je Bereich und Tag, mindestens 3 Bereiche', () => {
  const sets = [{}, { geld: 2, tech: 0.5 }, { tech: 2, erklaert: 2, natur: 0.5 }, { geld: 2, recht: 2, gesundheit: 2, haushalt: 2, digital: 2, verkehr: 2, tech: 0.5, erklaert: 0.5 }];
  for (const weights of sets) {
    for (let w = 0; w < 10; w += 1) {
      const monday = W.addDays('2026-11-09', 7 * w);
      const plan = W.weekPlan(monday, weights);
      eq(plan.length, 7);
      const counts = {};
      for (const day of plan) {
        eq(day.length, 5);
        const per = {};
        for (const a of day) { per[a] = (per[a] || 0) + 1; counts[a] = (counts[a] || 0) + 1; }
        assert.ok(Math.max(...Object.values(per)) <= 2);
        assert.ok(Object.keys(per).length >= 3);
      }
      eq(counts, W.weekCounts(weights, W.weekIndex(monday)));
    }
  }
});
test('Alles normal: jeder Tag folgt der Tabelle Alltag, Tech, Alltag, Erklärt, Welt', () => {
  for (let w = 0; w < 6; w += 1) {
    for (const day of W.weekPlan(W.addDays('2026-11-09', 7 * w), {})) {
      eq(day.map((a) => W.AREA_TYPE[a]), ['alltag', 'tech', 'alltag', 'erklaert', 'welt']);
      assert.notEqual(day[0], day[2], 'zwei verschiedene Alltagsbereiche am Tag');
    }
  }
});
test('Platzvergabe: Morgen bevorzugt Alltag, Mittag bevorzugt Tech', () => {
  eq(W.orderSlots(['natur', 'tech', 'geld', 'erklaert', 'recht']), ['geld', 'tech', 'recht', 'erklaert', 'natur']);
  eq(W.orderSlots(['tech', 'tech', 'geld', 'erklaert', 'natur']), ['geld', 'tech', 'tech', 'erklaert', 'natur']);
  eq(W.orderSlots(['natur', 'kultur', 'denken', 'erklaert', 'erklaert'])[0], 'natur');
});
test('Plan für beliebige Tage: Start mitten in der Woche, jeder Bereich mindestens einmal in 14 Tagen', () => {
  const dates = W.dateRange('2026-11-11', '2027-01-20');
  for (const weights of [{}, { natur: 0.5, kultur: 0.5, tech: 2 }]) {
    const cells = W.planDates(dates, weights, {});
    eq(cells.length, dates.length * 5);
    const byDate = {};
    for (const c of cells) (byDate[c.date] ||= []).push(c.area);
    for (let i = 13; i < dates.length; i += 1) {
      const win = dates.slice(i - 13, i + 1);
      for (const a of W.AREA_KEYS) assert.ok(win.some((d) => byDate[d].includes(a)), `${a} fehlt bis ${dates[i]}`);
    }
    for (const d of dates) {
      const per = {};
      for (const a of byDate[d]) per[a] = (per[a] || 0) + 1;
      assert.ok(Math.max(...Object.values(per)) <= 2 && Object.keys(per).length >= 3);
    }
  }
});
test('14-Tage-Regel greift auch gegen die vorhandene Vorgeschichte', () => {
  const history = {};
  for (const d of W.dateRange('2026-11-01', '2026-11-14')) history[d] = ['geld', 'tech', 'recht', 'erklaert', 'kultur'];
  const cells = W.planDates(['2026-11-15'], {}, history);
  const areas = cells.map((c) => c.area);
  const missing = W.AREA_KEYS.filter((a) => !history['2026-11-14'].includes(a));
  assert.ok(missing.some((a) => areas.includes(a)), 'ein lange fehlender Bereich wird eingeplant');
  eq(cells.map((c) => c.slot), [1, 2, 3, 4, 5]);
});
test('Datum: Wochenanfang und Zeitzone', () => {
  eq(W.mondayOf('2026-11-11'), '2026-11-09');
  eq(W.mondayOf('2026-11-15'), '2026-11-09');
  eq(W.mondayOf('2026-11-16'), '2026-11-16');
  eq(W.vienna(new Date('2026-11-10T23:05:00Z')), { date: '2026-11-11', hhmm: '0005' });
  eq(W.vienna(new Date('2026-07-01T21:59:00Z')), { date: '2026-07-01', hhmm: '2359' });
});

const good = (over = {}) => Object.assign({
  title: 'Zinseszins wirkt über die Zeit', kw: 'Zinseszins früh nutzen',
  text: 'Zinsen bringen im nächsten Jahr selbst wieder Zinsen. Dadurch wächst ein Betrag nicht gleichmäßig, sondern immer schneller. Entscheidend ist deshalb vor allem die Zeit. Wer früh mit kleinen Beträgen beginnt, erreicht oft mehr als jemand, der spät viel einzahlt. Schon wenige Jahre Vorsprung machen einen deutlichen Unterschied.',
  quiz: { question: 'Was zählt beim Zinseszins am meisten?', options: ['Die Zeit', 'Der Wochentag', 'Die Bank', 'Das Wetter'], correct: 0, explanation: 'Je länger Zinsen mitverzinst werden, desto stärker wächst der Betrag.' }
}, over);
test('Prüfung eines Fakts: Längen, Quiz, Emoji', () => {
  eq(W.validateFact(good()).errors, []);
  assert.match(W.validateFact(good({ title: 'x'.repeat(61) })).errors[0], /61 Zeichen/);
  assert.match(W.validateFact(good({ text: 'zu kurz' })).errors[0], /Wörter/);
  assert.match(W.validateFact(good({ text: Array(90).fill('Wort').join(' ') })).errors[0], /90 Wörter/);
  assert.match(W.validateFact(good({ mnemonic: Array(16).fill('a').join(' ') })).errors[0], /Merksatz/);
  assert.ok(W.validateFact(good({ quiz: { question: 'Q', options: ['a', 'b', 'c'], correct: 0, explanation: 'e' } })).errors.length);
  assert.ok(W.validateFact(good({ quiz: { question: 'Q', options: ['a', 'a', 'c', 'd'], correct: 0, explanation: 'e' } })).errors.length);
  assert.ok(W.validateFact(good({ quiz: { question: 'Q', options: ['a', 'b', 'c', 'd'], correct: 4, explanation: 'e' } })).errors.length);
  assert.ok(W.validateFact(good({ title: 'Geld 💰 sparen' })).errors.some((e) => /Emoji/.test(e)));
  assert.ok(W.validateFact(good({ kw: '' })).errors.length);
  eq(W.wordCount('  Eins zwei   drei-vier '), 3);
});
test('Prüfung eines Fakts: Hinweis bei Füller-Optionen und bei auffällig langer richtiger Antwort', () => {
  const quiz = (options, correct = 0) => good({ quiz: { question: 'Q?', options, correct, explanation: 'Ein Satz.' } });
  eq(W.validateFact(good()).warnings, []);
  const filler = W.validateFact(quiz(['100.000 Euro', '20.000 Euro', 'Gar nicht', '500.000 Euro']));
  eq(filler.errors, []);
  assert.ok(filler.warnings.some((w) => /Füller/.test(w) && /Gar nicht/.test(w)));
  // The filler word as the correct answer is not flagged.
  eq(W.validateFact(quiz(['Nie', 'Einmal im Jahr', 'Einmal im Monat', 'Jede Woche'])).warnings, []);
  const long = W.validateFact(quiz(['Kurz', 'Die richtige Antwort ist hier auffällig lang geraten', 'Knapp', 'Wenig'], 1));
  assert.ok(long.warnings.some((w) => /deutlich länger/.test(w)));
  eq(W.validateFact(quiz(['Sie gelten ab der Unterschrift', 'Sie werden nicht Vertragsbestandteil', 'Sie machen den Vertrag ungültig', 'Sie gelten nach 14 Tagen'], 1)).warnings, []);
});
test('Position der richtigen Antwort wird gleichmäßig verteilt, Inhalt bleibt richtig', () => {
  const facts = [];
  for (let i = 0; i < 70; i += 1) facts.push({ quiz: { question: 'Q' + i, options: ['richtig', 'f1', 'f2', 'f3'], correct: 0, explanation: 'e' } });
  W.spreadCorrect(facts, '2026-11-11-0900');
  const count = [0, 0, 0, 0];
  for (const f of facts) {
    eq(f.quiz.options[f.quiz.correct], 'richtig');
    eq(f.quiz.options.slice().sort(), ['f1', 'f2', 'f3', 'richtig']);
    count[f.quiz.correct] += 1;
  }
  assert.ok(Math.max(...count) - Math.min(...count) <= 2, count.join('/'));
  for (let i = 1; i < facts.length; i += 1) assert.notEqual(facts[i].quiz.correct === facts[i - 1].quiz.correct && facts[i].quiz.correct === (facts[i - 2] || { quiz: {} }).quiz.correct, true);
});

function dbWith(extra = {}) {
  return Object.assign({ facts: [], runs: [], digests: [], idx: {}, news: [], answers: [] }, extra);
}
test('Füllregel: bis 28 Tage voraus, höchstens 21 Tage pro Lauf, lückenlos', () => {
  const now = new Date('2026-11-15T10:07:00Z');
  let st = W.makeStatus(dbWith(), { now });
  eq(st.today, '2026-11-15');
  eq(st.batch, '2026-11-15-1107');
  eq(st.fill.length, 21);
  eq(st.fill[0], '2026-11-15');
  const day = (d) => ({ id: d, data: { date: d, items: Object.fromEntries([1, 2, 3, 4, 5].map((s) => [s, { id: `${d}-${s}`, slot: s, area: ['geld', 'tech', 'recht', 'erklaert', 'natur'][s - 1], title: `T ${d} ${s}` }])) } });
  const facts = W.dateRange('2026-11-11', '2026-12-09').map(day);
  st = W.makeStatus(dbWith({ facts }), { now });
  eq(st.lastDate, '2026-12-09');
  eq(st.fill, ['2026-12-10', '2026-12-11', '2026-12-12', '2026-12-13']);
  eq(st.replace, []);
  st = W.makeStatus(dbWith({ facts: W.dateRange('2026-11-11', '2026-12-13').map(day) }), { now });
  eq(st.fill, [], 'kein Bedarf');
  eq(st.cells, []);
  st = W.makeStatus(dbWith({ facts: W.dateRange('2026-10-01', '2026-10-20').map(day) }), { now });
  eq(st.fill[0], '2026-11-15', 'nach einer Lücke beginnt der neue Vorrat heute');
});
test('Geänderte Einstellungen: ersetzt wird ab heute plus 3 Tage, höchstens 14 Tage, Auffüllen hat Vorrang', () => {
  const now = new Date('2026-11-15T10:07:00Z');
  const day = (d) => ({ id: d, data: { date: d, items: Object.fromEntries([1, 2, 3, 4, 5].map((s) => [s, { id: `${d}-${s}`, slot: s, area: ['geld', 'tech', 'recht', 'erklaert', 'natur'][s - 1], title: `T ${d} ${s}` }])) } });
  const facts = W.dateRange('2026-11-11', '2026-12-06').map(day);
  const digest = { id: 'u_abc', data: { areaWeights: { geld: 2 }, settingsChangedAt: '2026-11-14T08:00:00Z', updatedAt: '2026-11-14T08:00:00Z', wish: 'Mehr Steuern' } };
  let st = W.makeStatus(dbWith({ facts, digests: [digest] }), { now });
  eq(st.needReplace, true);
  eq(st.replace[0], '2026-11-18');
  eq(st.replace[st.replace.length - 1], '2026-12-01');
  eq(st.replace.length, 14);
  eq(st.fill.length, 7);
  eq(st.weights.geld, 2);
  eq(st.wish, 'Mehr Steuern');
  eq(st.cells.length, 21 * 5);
  const run = { id: '2026-11-15-1107', data: { at: '2026-11-15T10:20:00Z', appliedSettingsAt: '2026-11-14T08:00:00Z', reportsHandledUntil: '2026-11-13T00:00:00Z' } };
  st = W.makeStatus(dbWith({ facts, digests: [digest], runs: [run] }), { now });
  eq(st.needReplace, false);
  eq(st.replace, []);
  eq(st.reportsHandledUntil, '2026-11-13T00:00:00Z');
});
test('Offene Fehlermeldungen und Recherchefragen: höchstens 10 und 5, älteste zuerst', () => {
  const now = new Date('2026-11-15T10:07:00Z');
  const reports = [], research = [];
  for (let i = 0; i < 13; i += 1) reports.push({ factId: '2026-11-11-1', note: 'n' + i, reportedAt: `2026-11-${String(10 + i).padStart(2, '0')}T08:00:00Z` });
  for (let i = 0; i < 7; i += 1) research.push({ id: 'r' + i, question: 'Frage ' + i, askedAt: `2026-11-1${i}T08:00:00Z` });
  const digests = [{ id: 'u_abc', data: { reports, research, updatedAt: 'x' } }];
  const runs = [{ id: 'a', data: { at: '2026-11-08T10:00:00Z', reportsHandledUntil: '2026-11-11T08:00:00Z' } }];
  const st = W.makeStatus(dbWith({ digests, runs, answers: [{ id: 'r0', data: {} }] }), { now });
  eq(st.openReports.length, 10);
  eq(st.openReports[0].note, 'n2');
  eq(st.openResearch.map((r) => r.id), ['r1', 'r2', 'r3', 'r4', 'r5']);
  eq(st.openResearch[0].uid, 'u_abc');
});
test('Bauen: fertige Tagesdokumente, Themenliste, keine Duplikate', () => {
  const now = new Date('2026-11-15T10:07:00Z');
  const db = dbWith({ idx: { '2026-11-12-1': { area: 'geld', kw: 'Notgroschen' } } });
  const st = W.makeStatus(db, { now, fillTo: '2026-11-16' });
  const plan = { today: st.today, batch: st.batch, cells: st.cells, replace: [], lastDate: null };
  eq(plan.cells.length, 10);
  const draft = plan.cells.map((c, i) => good({ date: c.date, slot: c.slot, area: c.area, title: 'Titel Nummer ' + i, kw: 'Thema' + i + ' eindeutig' + i }));
  let res = W.buildFacts(plan, draft, db);
  eq(res.errors, []);
  eq(Object.keys(res.days), ['2026-11-15', '2026-11-16']);
  const first = res.days['2026-11-15'].items['1'];
  eq([first.id, first.slot, first.block, first.batch], ['2026-11-15-1', 1, 'morgen', st.batch]);
  eq(first.type, W.AREA_TYPE[first.area]);
  eq(first.kw, undefined, 'das Schlagwort steht nur in der Themenliste');
  eq(first.quiz.options[first.quiz.correct], 'Die Zeit');
  for (const f of res.facts) eq(!!f.note, ['recht', 'gesundheit', 'geld'].includes(f.area));
  eq(Object.values(res.idxDoc.topics).reduce((n, m) => n + Object.keys(m).length, 0), 10);
  eq(res.writes.length, 3);
  eq(res.writes[2], { op: 'set', collection: 'idx', doc_id: st.batch, file: `idx/${st.batch}.json` });
  res = W.buildFacts(plan, draft.slice(1), db);
  assert.ok(res.errors.some((e) => /fehlt im Entwurf/.test(e)));
  const dup = draft.map((d) => ({ ...d }));
  dup[3].kw = 'Notgroschen';
  assert.ok(W.buildFacts(plan, dup, db).errors.some((e) => /gibt es schon/.test(e)));
  dup[3].kw = draft[3].kw; dup[4].title = draft[2].title;
  assert.ok(W.buildFacts(plan, dup, db).errors.some((e) => /gleicher Titel/.test(e)));
  const wrongArea = draft.map((d) => ({ ...d }));
  wrongArea[0].area = wrongArea[0].area === 'tech' ? 'geld' : 'tech';
  assert.ok(W.buildFacts(plan, wrongArea, db).errors.some((e) => /im Plan steht/.test(e)));
});
test('Bauen beim Ersetzen verlangt die Version des vorhandenen Dokuments', () => {
  const plan = { today: '2026-11-15', batch: 'b', cells: W.planDates(['2026-11-18'], {}, {}), replace: ['2026-11-18'], lastDate: '2026-12-06' };
  const draft = plan.cells.map((c, i) => good({ date: c.date, slot: c.slot, area: c.area, title: 'Neu ' + i, kw: 'neu' + i + ' thema' + i }));
  assert.ok(W.buildFacts(plan, draft, dbWith()).errors.some((e) => /Version fehlt/.test(e)));
  const res = W.buildFacts(plan, draft, dbWith(), { 'facts/2026-11-18': 3 });
  eq(res.errors, []);
  eq(res.writes[0].if_version, 3);
});
test('Aktuell: 3 bis 5 Meldungen mit Quelle, Recht dabei, 30 bis 60 Wörter', () => {
  const text = Array(40).fill('Wort').join(' ') + '.';
  const item = (area, n) => ({ area, title: 'Meldung ' + n, text, date: '2026-11-1' + n, source: { name: 'RIS', url: 'https://www.ris.bka.gv.at/' + n } });
  let res = W.buildNews([item('recht', 1), item('wirtschaft', 2), item('welt', 3)], dbWith(), '2026-11-15');
  eq(res.errors, []);
  eq(res.doc.date, '2026-11-15');
  eq(res.doc.items.map((i) => i.id), ['2026-11-15-n1', '2026-11-15-n2', '2026-11-15-n3']);
  eq(res.doc.items[0].note, 'Allgemeine Information, keine Beratung. Stand 15. November 2026.');
  eq(res.doc.items[2].note, undefined);
  eq(res.doc.items[0].upcoming, false);
  const future = item('recht', 1); future.date = '2026-12-01';
  eq(W.buildNews([future, item('politik', 2), item('tech', 3)], dbWith(), '2026-11-15').doc.items[0].upcoming, true);
  assert.ok(W.buildNews([item('politik', 1), item('welt', 2), item('tech', 3)], dbWith(), '2026-11-15').errors.some((e) => /recht/.test(e)));
  assert.ok(W.buildNews([item('recht', 1), item('welt', 2)], dbWith(), '2026-11-15').errors.some((e) => /3 bis 5/.test(e)));
  const noSource = item('recht', 1); noSource.source = { name: 'x', url: 'ftp://x' };
  assert.ok(W.buildNews([noSource, item('welt', 2), item('tech', 3)], dbWith(), '2026-11-15').errors.some((e) => /source/.test(e)));
  const exists = dbWith({ news: [{ id: '2026-11-15', data: { items: [] } }] });
  assert.ok(W.buildNews([item('recht', 1), item('welt', 2), item('tech', 3)], exists, '2026-11-15').errors.some((e) => /existiert schon/.test(e)));
});
test('Antworten auf Recherchefragen: höchstens 120 Wörter, 1 bis 3 Quellen', () => {
  const open = [{ id: 'r1', uid: 'u_abc', question: 'Gilt das auch bei Gebrauchtwaren?', ref: { kind: 'fact', id: '2026-11-11-1' }, askedAt: 'x' }];
  let res = W.buildAnswers([{ id: 'r1', answer: 'Ja, mit Einschränkungen.', sources: [{ name: 'oesterreich.gv.at', url: 'https://www.oesterreich.gv.at/x' }] }], open);
  eq(res.errors, []);
  eq([res.docs[0].id, res.docs[0].uid, res.docs[0].question], ['r1', 'u_abc', open[0].question]);
  assert.ok(W.buildAnswers([{ id: 'r9', answer: 'x', sources: [] }], open).errors.length);
  assert.ok(W.buildAnswers([{ id: 'r1', answer: Array(130).fill('w').join(' '), sources: [{ name: 'a', url: 'https://a.at' }] }], open).errors.some((e) => /120/.test(e)));
  assert.ok(W.buildAnswers([{ id: 'r1', answer: 'x', sources: [] }], open).errors.some((e) => /Quellen/.test(e)));
});

if (failures.length) {
  for (const f of failures) console.error('FEHLER  ' + f.name + '\n        ' + String(f.e && f.e.message).split('\n').join('\n        '));
  console.error('\n' + passed + ' bestanden, ' + failures.length + ' fehlgeschlagen');
  process.exit(1);
}
console.log('Wochenladung: ' + passed + ' Tests bestanden');

// Tests for lumen-usage.js (tab "Auslastung"). Run: node tests/usage.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const U = createRequire(import.meta.url)('../lumen-usage.js');
let n = 0;
const test = (name, fn) => { fn(); n += 1; };
const NOW = Date.parse('2026-11-24T20:00:00Z');
const day = (date, reads, writes = 100, deletes = 0) => ({ date, reads, writes, deletes });

test('no measurement yet', () => {
  const a = U.assess(null, 20, NOW);
  assert.equal(a.verdict.level, 'ok');
  assert.ok(a.stale);
  assert.equal(a.items.find((i) => i.key === 'reads').level, 'unknown');
});
test('missing monitoring access is explained', () => {
  const a = U.assess({ at: '2026-11-24T19:30:00Z', monitoring: { ok: false, error: 'PERMISSION_DENIED' } }, 20, NOW);
  assert.ok(a.lacksAccess);
  assert.ok(!a.stale);
});
test('low use is green with a people forecast', () => {
  const a = U.assess({ at: '2026-11-24T19:30:00Z', monitoring: { ok: true }, firestore: { today: '2026-11-24', days: [day('2026-11-23', 3000), day('2026-11-24', 1200)] } }, 20, NOW);
  const r = a.items.find((i) => i.key === 'reads');
  assert.equal(r.level, 'ok');
  assert.equal(r.perPerson, 150);
  assert.match(r.forecast, /Platz für rund 266 Personen/);
  assert.equal(a.verdict.level, 'ok');
});
test('a heavy day turns the verdict', () => {
  const warn = U.assess({ at: '2026-11-24T19:30:00Z', firestore: { today: '2026-11-24', days: [day('2026-11-24', 35000)] } }, 20, NOW);
  assert.equal(warn.verdict.level, 'warn');
  const alert = U.assess({ at: '2026-11-24T19:30:00Z', firestore: { today: '2026-11-24', days: [day('2026-11-20', 46000), day('2026-11-24', 2000)] } }, 20, NOW);
  assert.equal(alert.verdict.level, 'alert');
  assert.match(alert.verdict.text, /Blaze/);
});
test('storage growth gives a time until full', () => {
  const a = U.assess({ at: '2026-11-24T19:30:00Z', storage: { bytes: 2e6, history: [{ date: '2026-11-14', bytes: 1e6 }, { date: '2026-11-24', bytes: 2e6 }] } }, 20, NOW);
  const s = a.items.find((i) => i.key === 'storage');
  assert.equal(s.level, 'ok');
  assert.match(s.forecast, /Voll in mehr als 10 Jahre|Voll in etwa \d+ Jahre/);
});
test('old measurement is flagged', () => {
  const a = U.assess({ at: '2026-11-24T10:00:00Z' }, 20, NOW);
  assert.ok(a.stale);
  assert.match(a.verdict.note, /10 Stunden/);
});
console.log(`Auslastung: ${n} Tests bestanden`);

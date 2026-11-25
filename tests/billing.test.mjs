// Tests for lumen-billing.js (payment concept). Run: node tests/billing.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const B = createRequire(import.meta.url)('../lumen-billing.js');
let n = 0;
const test = (name, fn) => { try { fn(); n += 1; } catch (e) { console.error('FEHLER: ' + name); throw e; } };
const NOW = Date.parse('2026-11-25T12:00:00Z');
const T = '2026-11-25';

test('no record yet: usable', () => {
  const a = B.access(null, NOW, T);
  assert.equal(a.state, 'none');
  assert.ok(B.usable(a));
});
test('trial: days left, then over', () => {
  const b = { status: 'trial', trialStart: '2026-11-24T12:00:00Z', trialDays: 3 };
  const a = B.access(b, NOW, T);
  assert.equal(a.state, 'trial');
  assert.equal(Math.round(a.hoursLeft), 48);
  assert.match(B.banner(a).text, /noch 2 Tage/);
  const late = B.access(b, Date.parse('2026-11-27T11:00:00Z'), '2026-11-27');
  assert.equal(B.banner(late).level, 'warn');
  assert.match(B.banner(late).text, /heute/);
  const over = B.access(b, Date.parse('2026-11-27T12:00:01Z'), '2026-11-27');
  assert.equal(over.state, 'trialOver');
  assert.ok(!B.usable(over));
});
test('trial with pending server time and Firestore timestamp', () => {
  assert.equal(B.access({ status: 'trial', trialStart: null }, NOW, T).state, 'trial');
  const ts = { toMillis: () => NOW - 4 * 86400000 };
  assert.equal(B.access({ status: 'trial', trialStart: ts, trialDays: 3 }, NOW, T).state, 'trialOver');
  assert.equal(B.access({ status: 'trial', trialStart: { seconds: NOW / 1000 } }, NOW, T).state, 'trial');
});
test('admin and locked', () => {
  assert.equal(B.access({ admin: true, status: 'trial', trialStart: '2020-01-01T00:00:00Z' }, NOW, T).state, 'admin');
  const l = B.access({ status: 'locked', message: 'Bitte zahlen' }, NOW, T);
  assert.equal(l.state, 'locked');
  assert.equal(l.message, 'Bitte zahlen');
  assert.ok(!B.usable(l));
});
test('open: banner only close to the payday', () => {
  const b = { status: 'open', amount: 1, nextPay: '2026-12-10' };
  assert.equal(B.banner(B.access(b, NOW, T)), null);
  assert.match(B.banner(B.access(b, NOW, '2026-12-08')).text, /In 2 Tagen.*1 €/);
  assert.match(B.banner(B.access(b, NOW, '2026-12-09')).text, /Morgen/);
  assert.match(B.banner(B.access(b, NOW, '2026-12-10')).text, /Heute ist Zahltag/);
  assert.match(B.banner(B.access(b, NOW, '2026-12-12')).text, /war am 10\. Dezember/);
  assert.match(B.banner(B.access({ status: 'open', amount: 2.5, nextPay: T }, NOW, T)).text, /2,50 €/);
});
test('next month keeps the pay day, short months take their last day', () => {
  assert.equal(B.nextMonth('2026-11-25'), '2026-12-25');
  assert.equal(B.nextMonth('2026-12-15'), '2027-01-15');
  assert.equal(B.nextMonth('2027-01-31', 31), '2027-02-28');
  assert.equal(B.nextMonth('2027-02-28', 31), '2027-03-31');
  assert.equal(B.afterPayment({ nextPay: '2027-01-31', payDay: 31 }, T), '2027-02-28');
  assert.equal(B.afterPayment({}, T), '2026-12-25');
});
test('reminders: on the payday, then two weeks later, each once', () => {
  const b = { status: 'open', nextPay: '2026-12-10' };
  assert.deepEqual(B.reminders(b, '2026-12-09'), []);
  assert.deepEqual(B.reminders(b, '2026-12-10'), [{ kind: 'due', due: '2026-12-10' }]);
  assert.deepEqual(B.reminders({ ...b, remind1: '2026-12-10' }, '2026-12-11'), []);
  assert.deepEqual(B.reminders({ ...b, remind1: '2026-12-10' }, '2026-12-24'), [{ kind: 'late', due: '2026-12-10' }]);
  assert.deepEqual(B.reminders({ ...b, remind1: '2026-12-10', remind2: '2026-12-10' }, '2026-12-30'), []);
  // paid: the next payday moved on, so nothing is owed
  assert.deepEqual(B.reminders({ ...b, nextPay: '2027-01-10', remind1: '2026-12-10' }, '2026-12-24'), []);
  assert.deepEqual(B.reminders({ status: 'locked', nextPay: '2026-12-10' }, '2026-12-10'), []);
  assert.deepEqual(B.reminders({ admin: true, status: 'open', nextPay: '2026-12-10' }, '2026-12-10'), []);
});
test('transfer reference', () => {
  assert.equal(B.reference('Anna', 'a@b.at'), 'Lumen Anna');
  assert.equal(B.reference('', 'max.muster@b.at'), 'Lumen max.muster');
});
console.log(n + ' Tests bestanden.');

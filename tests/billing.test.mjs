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
test('payment log: kept short, amounts rounded, lateness', () => {
  let b = {};
  for (let i = 0; i < 130; i += 1) b = { payments: B.withPayment(b, '2026-11-25T10:00:00Z', 1.005, '2026-11-20') };
  assert.equal(b.payments.length, 120);
  assert.equal(B.lateBy(b.payments[0]), 5);
  assert.equal(B.lateBy({ at: '2026-11-19T23:30:00Z', due: '2026-11-20' }), 0); // 00:30 in Vienna: on the payday
  assert.equal(B.lateBy({ at: '2026-11-19T10:00:00Z', due: null }), null);
});
test('statistics: income, overdue, upcoming, conversion, punctuality', () => {
  const p = (uid, b) => ({ uid, name: uid, b, a: B.access(b, NOW, T) });
  const people = [
    p('admin', { admin: true, status: 'open' }),
    p('anna', { status: 'open', amount: 2, nextPay: '2026-12-01', unlockedAt: '2026-10-01T10:00:00Z',
      payments: [{ at: '2026-10-01T10:00:00Z', amount: 2, due: '2026-10-01' }, { at: '2026-11-03T10:00:00Z', amount: 2, due: '2026-11-01' }] }),
    p('berta', { status: 'open', amount: 3, nextPay: '2026-11-20', payments: [{ at: '2026-11-25T08:00:00Z', amount: 3, due: '2026-10-20' }] }),
    p('carl', { status: 'trial', trialStart: '2026-11-25T08:00:00Z', trialDays: 3 }),
    p('dora', { status: 'trial', trialStart: '2026-11-01T08:00:00Z', trialDays: 3 }),
    p('emil', { status: 'locked', unlockedAt: '2026-09-01T10:00:00Z', payments: [{ at: '2026-09-01T10:00:00Z', amount: 1, due: '2026-09-01' }] })
  ];
  const s = B.stats(people, T);
  assert.equal(s.monthly, 5);
  assert.equal(s.paying, 2);
  assert.equal(s.totalPaid, 8);
  assert.equal(s.paymentsCount, 4);
  assert.equal(s.thisMonth, 5);
  assert.equal(s.lastMonth, 2);
  assert.equal(s.months.length, 12);
  assert.equal(s.months[11].month, '2026-11');
  assert.deepEqual(s.overdue.map((x) => [x.uid, x.days]), [['berta', 5]]);
  assert.equal(s.overdueSum, 3);
  assert.deepEqual(s.upcoming.map((x) => [x.uid, x.inDays]), [['anna', 6]]);
  assert.deepEqual(s.funnel, { signedUp: 5, decided: 4, converted: 3, paying: 2, left: 1, rate: 75, keep: 67 });
  assert.equal(s.counts.trial, 1);
  assert.equal(s.counts.trialOver, 1);
  assert.equal(s.punctuality.count, 4);
  assert.equal(s.punctuality.onTime, 2);
  assert.equal(s.punctuality.avgLate, 19);
  assert.equal(s.perPerson[0].uid, 'anna');
  assert.equal(s.perPerson[0].onTime, 50);
  assert.equal(s.payments[0].uid, 'berta');
  assert.ok(!s.perPerson.some((x) => x.uid === 'admin'));
});
console.log(n + ' Tests bestanden.');

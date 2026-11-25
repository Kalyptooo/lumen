/* Lumen payment logic (concept of 2026-11-25): everyone signs up alone, uses the full app for a few free days,
   then the admin unlocks the person by hand after a personal bank transfer, paid monthly in advance.
   Per person (Firestore billing/<uid>):
     status      'trial' (free days), 'open' (unlocked by the admin) or 'locked' (locked by the admin)
     trialStart  server time of the first visit; trialDays: free days (from config/billing.trialDays, default 3)
     amount      euros per month; payDay: day of the month; nextPay: next payment date (YYYY-MM-DD)
     remindPush  payment reminder on the phone; remindEmail: by e-mail (not set up yet)
     message     shown to the person when locked; admin: true for admins (never locked)
     remind1 / remind2: the due date for which the first / second reminder went out (written by tools/billing-reminders.mjs)
     payments    log of confirmed payments [{ at, amount, due }] for the statistics (written by the admin page)
   The real lock is in firestore.rules; this file only decides what the pages show and which reminders are owed.
   Used by index.html, admin.html, lumen-connect.js and tools/billing-reminders.mjs. Pure functions, tested in tests/billing.test.mjs. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const TRIAL_DAYS = 3;
  const LATE_AFTER = 14; // second reminder this many days after the payday
  const WARN_DAYS = 3;   // the app warns this many days before the payday
  const pad = function (n) { return String(n).padStart(2, '0'); };
  const isDate = function (d) { return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d); };

  /* Firestore timestamp, {seconds}, ISO text or milliseconds → milliseconds (NaN if unknown, e.g. a server time still pending). */
  function ms(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    return Date.parse(v);
  }
  function addDays(d, n) { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  const daysBetween = function (a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAY); };
  /* The pay day in a given month; a 31st becomes the last day of shorter months. */
  function inMonth(year, month, payDay) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return year + '-' + pad(month) + '-' + pad(Math.min(Math.max(1, payDay), last));
  }
  /* The same pay day one month later. */
  function nextMonth(date, payDay) {
    const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
    return inMonth(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, payDay || Number(date.slice(8, 10)));
  }
  const trialDaysOf = function (b) { return Number.isInteger(b && b.trialDays) && b.trialDays >= 0 ? b.trialDays : TRIAL_DAYS; };

  /* What the person may do right now.
     state: 'none' (no record yet), 'admin', 'trial', 'trialOver', 'open' or 'locked'. */
  function access(b, now, today) {
    if (!b) return { state: 'none' };
    if (b.admin) return { state: 'admin' };
    if (b.status === 'locked') return { state: 'locked', message: String(b.message || '') };
    if (b.status === 'open') {
      const due = isDate(b.nextPay) ? b.nextPay : null;
      return { state: 'open', due: due, dueIn: due && isDate(today) ? daysBetween(today, due) : null, amount: Number(b.amount) || 0 };
    }
    const start = ms(b.trialStart);
    if (isNaN(start)) return { state: 'trial', end: null, hoursLeft: trialDaysOf(b) * 24 };
    const end = start + trialDaysOf(b) * DAY;
    return end > now ? { state: 'trial', end: end, hoursLeft: (end - now) / 3600000 } : { state: 'trialOver', end: end, message: String(b.message || '') };
  }
  const usable = function (a) { return a.state === 'none' || a.state === 'admin' || a.state === 'trial' || a.state === 'open'; };

  function euro(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('de-AT', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
  }
  function longDate(d) {
    return new Date(d + 'T12:00:00Z').toLocaleDateString('de-AT', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  }

  /* The small line on "Heute": free days left, or the payday coming up or passed. null when there is nothing to say. */
  function banner(a) {
    if (a.state === 'trial') {
      const days = Math.max(1, Math.ceil(a.hoursLeft / 24));
      return { level: a.hoursLeft <= 24 ? 'warn' : 'info',
        text: (a.hoursLeft <= 24 ? 'Deine Gratis-Zeit endet ' + (a.hoursLeft <= 12 ? 'heute' : 'morgen') + '.' : 'Gratis-Zeit: noch ' + days + ' Tage.') +
          ' Danach meldest du dich beim Admin, um weiterzumachen.' };
    }
    if (a.state === 'open' && a.due && a.dueIn !== null && a.dueIn <= WARN_DAYS) {
      const what = a.amount ? euro(a.amount) : 'deinen Beitrag';
      if (a.dueIn > 1) return { level: 'info', text: 'In ' + a.dueIn + ' Tagen ist Zahltag. Bitte überweise ' + what + '.' };
      if (a.dueIn === 1) return { level: 'info', text: 'Morgen ist Zahltag. Bitte überweise ' + what + '.' };
      if (a.dueIn === 0) return { level: 'warn', text: 'Heute ist Zahltag. Bitte überweise ' + what + '.' };
      return { level: 'warn', text: 'Der Zahltag war am ' + longDate(a.due) + '. Bitte überweise ' + what + '.' };
    }
    return null;
  }

  /* Payment reminders owed today: 'due' on the payday, 'late' two weeks after it. Each once per payday. */
  function reminders(b, today) {
    if (!b || b.admin || b.status !== 'open' || !isDate(b.nextPay) || !isDate(today)) return [];
    if (today >= addDays(b.nextPay, LATE_AFTER)) return b.remind2 === b.nextPay ? [] : [{ kind: 'late', due: b.nextPay }];
    if (today >= b.nextPay) return b.remind1 === b.nextPay ? [] : [{ kind: 'due', due: b.nextPay }];
    return [];
  }

  /* After the admin marks a payment as received: the next payday one month later. */
  function afterPayment(b, today) {
    const base = b && isDate(b.nextPay) ? b.nextPay : today;
    return nextMonth(base, (b && b.payDay) || Number(base.slice(8, 10)));
  }

  /* ---------- payment log and statistics (admin tab "Einnahmen") ----------
     billing/<uid>.payments: [{ at: ISO time the admin confirmed it, amount: euros, due: payday it was for (YYYY-MM-DD) }],
     written by the admin page, newest last, at most PAYMENTS_KEPT entries. */
  const PAYMENTS_KEPT = 120;
  const viennaDay = function (iso) {
    const t = ms(iso);
    if (isNaN(t)) return '';
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  };
  const paymentsOf = function (b) {
    return (b && Array.isArray(b.payments) ? b.payments : []).filter(function (p) { return p && !isNaN(ms(p.at)) && Number(p.amount) >= 0; });
  };
  /* The log after one more payment. */
  function withPayment(b, atIso, amount, due) {
    return paymentsOf(b).concat([{ at: atIso, amount: Math.round((Number(amount) || 0) * 100) / 100, due: isDate(due) ? due : null }]).slice(-PAYMENTS_KEPT);
  }
  /* Days a payment came after its payday (0 or less: on time). null without a payday. */
  const lateBy = function (p) { return isDate(p.due) ? daysBetween(p.due, viennaDay(p.at)) : null; };
  const monthKey = function (d) { return d.slice(0, 7); };
  function lastMonths(today, n) {
    const out = [];
    let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    for (let i = 0; i < n; i += 1) { out.unshift(y + '-' + pad(m)); m -= 1; if (!m) { m = 12; y -= 1; } }
    return out;
  }

  /* Everything the "Einnahmen" tab shows. people: [{ uid, name, b (billing record or {}), a (access(b, …)) }]. */
  function stats(people, today) {
    const sum = function (list, f) { return Math.round(list.reduce(function (n, x) { return n + (Number(f(x)) || 0); }, 0) * 100) / 100; };
    const rows = people.filter(function (p) { return p.a.state !== 'admin'; });
    const open = rows.filter(function (p) { return p.a.state === 'open'; });
    const all = [];
    rows.forEach(function (p) { paymentsOf(p.b).forEach(function (x) { all.push(Object.assign({ uid: p.uid, name: p.name, day: viennaDay(x.at) }, x)); }); });
    all.sort(function (x, y) { return x.day < y.day ? -1 : x.day > y.day ? 1 : 0; });
    const thisMonth = monthKey(today), months = lastMonths(today, 12), prevMonth = months[10];
    const byMonth = months.map(function (k) {
      const list = all.filter(function (x) { return monthKey(x.day) === k; });
      return { month: k, sum: sum(list, function (x) { return x.amount; }), count: list.length };
    });
    const overdue = open.filter(function (p) { return p.a.dueIn !== null && p.a.dueIn < 0; })
      .map(function (p) { return { uid: p.uid, name: p.name, amount: Number(p.b.amount) || 0, due: p.a.due, days: -p.a.dueIn }; })
      .sort(function (x, y) { return y.days - x.days; });
    const upcoming = open.filter(function (p) { return p.a.dueIn !== null && p.a.dueIn >= 0 && p.a.dueIn <= 30; })
      .map(function (p) { return { uid: p.uid, name: p.name, amount: Number(p.b.amount) || 0, due: p.a.due, inDays: p.a.dueIn }; })
      .sort(function (x, y) { return x.inDays - y.inDays; });
    // From free days to paying: who had the chance to decide, who ever paid or was unlocked, who still pays, who left again.
    const everOpen = function (p) { return p.a.state === 'open' || !!p.b.unlockedAt || paymentsOf(p.b).length > 0; };
    const decided = rows.filter(function (p) { return p.a.state === 'trialOver' || p.a.state === 'locked' || everOpen(p); });
    const converted = rows.filter(everOpen);
    const left = rows.filter(function (p) { return p.a.state === 'locked' && everOpen(p); });
    const dated = all.filter(function (x) { return lateBy(x) !== null; });
    const late = dated.filter(function (x) { return lateBy(x) > 0; });
    const payers = {};
    all.forEach(function (x) { payers[x.uid] = true; });
    const perPerson = rows.map(function (p) {
      const list = paymentsOf(p.b), d = list.filter(function (x) { return lateBy(x) !== null; });
      return { uid: p.uid, name: p.name, state: p.a.state, amount: p.a.state === 'open' ? Number(p.b.amount) || 0 : 0,
        since: p.b.unlockedAt ? viennaDay(p.b.unlockedAt) : (list.length ? viennaDay(list[0].at) : ''),
        payments: list.length, paid: sum(list, function (x) { return x.amount; }), lastPaid: list.length ? viennaDay(list[list.length - 1].at) : '',
        onTime: d.length ? Math.round(100 * d.filter(function (x) { return lateBy(x) <= 0; }).length / d.length) : null,
        due: p.a.state === 'open' ? p.a.due : null };
    }).sort(function (x, y) { return (y.paid - x.paid) || (y.amount - x.amount) || String(x.name).localeCompare(String(y.name), 'de'); });
    const counts = { total: rows.length, none: 0, trial: 0, trialOver: 0, open: 0, locked: 0 };
    rows.forEach(function (p) { counts[p.a.state] = (counts[p.a.state] || 0) + 1; });
    const totalPaid = sum(all, function (x) { return x.amount; });
    return {
      monthly: sum(open, function (p) { return p.b.amount; }), paying: open.length,
      avgAmount: open.length ? Math.round(100 * sum(open, function (p) { return p.b.amount; }) / open.length) / 100 : 0,
      totalPaid: totalPaid, paymentsCount: all.length, firstPayment: all.length ? all[0].day : '',
      thisMonth: byMonth[11].sum, lastMonth: byMonth[10].sum, thisMonthKey: thisMonth, lastMonthKey: prevMonth,
      perPayer: Object.keys(payers).length ? Math.round(100 * totalPaid / Object.keys(payers).length) / 100 : 0,
      months: byMonth,
      overdue: overdue, overdueSum: sum(overdue, function (x) { return x.amount; }),
      upcoming: upcoming, upcomingSum: sum(upcoming, function (x) { return x.amount; }),
      counts: counts,
      funnel: { signedUp: rows.length, decided: decided.length, converted: converted.length, paying: open.length, left: left.length,
        rate: decided.length ? Math.round(100 * converted.length / decided.length) : null,
        keep: converted.length ? Math.round(100 * open.length / converted.length) : null },
      punctuality: { count: dated.length, onTime: dated.length - late.length, rate: dated.length ? Math.round(100 * (dated.length - late.length) / dated.length) : null,
        avgLate: late.length ? Math.round(10 * late.reduce(function (n, x) { return n + lateBy(x); }, 0) / late.length) / 10 : 0 },
      perPerson: perPerson,
      payments: all.slice().reverse()
    };
  }

  /* Reference for the bank transfer, so the admin can match payments. */
  function reference(name, email) {
    const who = String(name || '').trim() || String(email || '').split('@')[0];
    return ('Lumen ' + who).slice(0, 40);
  }

  const api = { TRIAL_DAYS: TRIAL_DAYS, LATE_AFTER: LATE_AFTER, WARN_DAYS: WARN_DAYS, ms: ms, addDays: addDays, daysBetween: daysBetween,
    nextMonth: nextMonth, access: access, usable: usable, banner: banner, reminders: reminders, afterPayment: afterPayment,
    reference: reference, euro: euro, longDate: longDate, viennaDay: viennaDay, paymentsOf: paymentsOf, withPayment: withPayment, lateBy: lateBy, stats: stats };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LumenBilling = api;
})(typeof self !== 'undefined' ? self : this);

/* Lumen payment logic (concept of 2026-11-25): everyone signs up alone, uses the full app for a few free days,
   then the admin unlocks the person by hand after a personal bank transfer, paid monthly in advance.
   Per person (Firestore billing/<uid>):
     status      'trial' (free days), 'open' (unlocked by the admin) or 'locked' (locked by the admin)
     trialStart  server time of the first visit; trialDays: free days (from config/billing.trialDays, default 3)
     amount      euros per month; payDay: day of the month; nextPay: next payment date (YYYY-MM-DD)
     remindPush  payment reminder on the phone; remindEmail: by e-mail (not set up yet)
     message     shown to the person when locked; admin: true for admins (never locked)
     remind1 / remind2: the due date for which the first / second reminder went out (written by tools/billing-reminders.mjs)
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

  /* Reference for the bank transfer, so the admin can match payments. */
  function reference(name, email) {
    const who = String(name || '').trim() || String(email || '').split('@')[0];
    return ('Lumen ' + who).slice(0, 40);
  }

  const api = { TRIAL_DAYS: TRIAL_DAYS, LATE_AFTER: LATE_AFTER, WARN_DAYS: WARN_DAYS, ms: ms, addDays: addDays, daysBetween: daysBetween,
    nextMonth: nextMonth, access: access, usable: usable, banner: banner, reminders: reminders, afterPayment: afterPayment,
    reference: reference, euro: euro, longDate: longDate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LumenBilling = api;
})(typeof self !== 'undefined' ? self : this);

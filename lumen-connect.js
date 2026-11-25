/* Lumen connector for an outside dashboard (contract version 1, described in CONNECT.md).
   One script tag on the dashboard, then:
     const lumen = await LumenConnect.connect();
     await lumen.signIn(email, password);       // admin account, once; the login is remembered
     const s = await lumen.summary();           // the numbers that matter, plus hints that need attention
     await lumen.run('notice', 'Text');         // everyday admin actions
     lumen.link('people', uid);                 // bigger changes: open the admin page right there
   Works from any page: it loads Firebase and the project settings itself and uses its own Firebase app,
   so it never clashes with the dashboard's own Firebase. The database rules decide what is allowed. */
(function () {
  'use strict';
  const CONTRACT = 1;
  const script = document.currentScript;
  const BASE = script && script.src ? script.src.replace(/[^/]*([?#].*)?$/, '') : './';
  const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const FRESH_HOURS = 12, CACHE_MS = 5 * 60000;
  const AREAS = {
    geld: 'Geld & Finanzen', recht: 'Recht & Verträge', gesundheit: 'Körper, Gesundheit & Psyche', haushalt: 'Haushalt, Kochen & Hacks',
    digital: 'Digitale Sicherheit', verkehr: 'Auto, Verkehr & Reisen', tech: 'Tech & Geräte', erklaert: 'Wie funktioniert das?',
    natur: 'Natur & Wissenschaft', geschichte: 'Geschichte & Politik', kultur: 'Geografie, Kultur & Sprache', denken: 'Denken & Kommunikation'
  };
  const ADMIN_SECTIONS = ['overview', 'people', 'money', 'settings', 'facts', 'reports', 'weekly', 'usage', 'billing'];
  const INFO = {
    id: 'lumen', name: 'Lumen', contract: CONTRACT, description: 'Allgemeinwissen: jeden Tag ein paar Fakten, Quiz und Auffrischung.',
    icon: BASE + 'icon-180.png', app: BASE, admin: BASE + 'admin.html'
  };
  const ERRORS = {
    'auth/invalid-credential': 'E-Mail oder Passwort stimmt nicht.', 'auth/invalid-login-credentials': 'E-Mail oder Passwort stimmt nicht.',
    'auth/wrong-password': 'E-Mail oder Passwort stimmt nicht.', 'auth/user-not-found': 'E-Mail oder Passwort stimmt nicht.',
    'auth/too-many-requests': 'Zu viele Versuche. Bitte warte ein paar Minuten.', 'auth/network-request-failed': 'Keine Verbindung zum Internet.',
    'permission-denied': 'Kein Zugriff. Melde dich mit dem Admin-Konto an (spätestens alle 12 Stunden neu).',
    'not-signed-in': 'Bitte zuerst mit dem Admin-Konto anmelden.', 'bad-input': 'Die Eingabe passt nicht.',
    'not-here': 'Das geht nur auf der Admin-Seite.', 'unknown-action': 'Diese Aktion gibt es nicht.'
  };
  const fail = function (code, e) {
    const err = new Error(ERRORS[code] || (e && ERRORS[e.code]) || 'Das hat gerade nicht geklappt.');
    err.code = (e && e.code) || code;
    err.lumen = true;
    return err;
  };
  const norm = function (e) { return String(e || '').trim().toLowerCase(); };
  const todayVienna = function () {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  };
  const addDays = function (d, n) { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const daysBetween = function (a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); };
  const load = function (src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = function () { reject(fail('network', { code: 'auth/network-request-failed' })); };
      document.head.appendChild(s);
    });
  };
  const getJSON = function (path) {
    return fetch(BASE + path, { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  };

  let pending = null;
  function connect() {
    if (pending) return pending;
    pending = (async function () {
      let auth, db, fb = null;
      if (!window.LumenUsage) await load(BASE + 'lumen-usage.js');
      if (!window.LumenBilling) await load(BASE + 'lumen-billing.js');
      const fake = window.LumenCloud && window.LumenCloud.fake ? window.LumenCloud : null;
      if (fake) { auth = fake.auth; db = fake.db; }
      else {
        if (!window.firebase || !window.firebase.initializeApp) await load(FB + 'firebase-app-compat.js');
        if (!window.firebase.auth) await load(FB + 'firebase-auth-compat.js');
        if (!window.firebase.firestore) await load(FB + 'firebase-firestore-compat.js');
        if (!self.LUMEN_FIREBASE) await load(BASE + 'firebase-config.js');
        fb = window.firebase;
        const app = fb.apps.filter(function (a) { return a.name === 'lumen-connect'; })[0] || fb.initializeApp(self.LUMEN_FIREBASE, 'lumen-connect');
        auth = app.auth(); auth.languageCode = 'de';
        db = app.firestore();
      }
      // Wait until a remembered login is restored.
      await new Promise(function (resolve) { let off = null; off = auth.onAuthStateChanged(function () { if (off) off(); resolve(); }); });
      return makeApi(auth, db, fb);
    })();
    pending.catch(function () { pending = null; });
    return pending;
  }

  function makeApi(auth, db, fb) {
    let cache = null, cacheAt = 0;
    const user = function () { return auth.currentUser; };
    const guard = function () { if (!user()) throw fail('not-signed-in'); };
    const wrap = function (p) { return p.catch(function (e) { throw e && e.lumen ? e : fail('x', e); }); };
    const changed = function () { cache = null; };

    async function fresh() {
      const u = user();
      if (!u || !u.getIdTokenResult) return !!u;
      try { const t = await u.getIdTokenResult(); return Date.now() - Date.parse(t.authTime) < FRESH_HOURS * 3600000; } catch (e) { return true; }
    }
    async function state() {
      const u = user();
      if (!u) return { signedIn: false, admin: false };
      const out = { signedIn: true, email: u.email || '', verified: !!u.emailVerified, fresh: await fresh(), admin: false };
      try { await db.doc('config/access').get(); out.admin = true; } catch (e) { out.admin = false; }
      return out;
    }
    async function access() {
      const a = await db.doc('config/access').get();
      const d = a.exists ? (a.data() || {}) : {};
      return { adminEmails: (d.adminEmails || []).map(norm), usage: d.usage || null,
        events: Array.isArray(d.events) ? d.events : [], eventsSeenAt: d.eventsSeenAt || '',
        removedReports: Array.isArray(d.removedReports) ? d.removedReports : [] };
    }

    async function gather() {
      guard();
      const got = await Promise.all([access(), db.doc('config/public').get(), db.collection('members').get(), db.collection('digest').get(),
        db.collection('push').get().catch(function () { return { docs: [] }; }), getJSON('data/manifest.json?t=' + Date.now()),
        db.collection('billing').get().catch(function () { return { docs: [] }; })]);
      const acc = got[0], pub = got[1].exists ? (got[1].data() || {}) : {};
      const members = {}, digests = {};
      got[2].docs.forEach(function (d) { members[d.id] = d.data() || {}; });
      got[3].docs.forEach(function (d) { digests[d.id] = d.data() || {}; });
      const pushOn = got[4].docs.filter(function (d) { const x = d.data() || {}; return x.enabled === true && !!x.token; }).length;
      const bills = {};
      got[6].docs.forEach(function (d) { bills[d.id] = d.data() || {}; });
      return { acc: acc, pub: pub, members: members, digests: digests, pushOn: pushOn, manifest: got[5] || {}, bills: bills };
    }
    function rowsOf(g) {
      return Object.keys(Object.assign({}, g.members, g.digests)).map(function (uid) {
        const m = g.members[uid] || {}, d = g.digests[uid] || {}, email = norm(m.email);
        let right = 0, total = 0;
        Object.keys(d.areaAccuracy || {}).forEach(function (k) {
          const a = d.areaAccuracy[k];
          if (a && a.answered && a.pct !== null) { right += a.pct * a.answered / 100; total += a.answered; }
        });
        const admin = g.acc.adminEmails.indexOf(email) !== -1;
        const pay = admin ? { state: 'admin' } : window.LumenBilling.access(g.bills[uid] || null, Date.now(), todayVienna());
        return {
          uid: uid, name: m.name || d.name || '', email: m.email || '', lastSeen: m.lastSeen || d.lastDay || '', streak: d.streak || 0,
          learned: d.seenCount || 0, answered: d.answered || 0, pct: total ? Math.round(100 * right / total) : null, due: d.dueCount || 0,
          reports: (d.reports || []).length, active: d.activeDays || [], admin: admin, unlocked: window.LumenBilling.usable(pay),
          access: pay.state, amount: pay.state === 'open' ? pay.amount : null, nextPay: pay.state === 'open' ? pay.due : null,
          link: link('people', uid)
        };
      });
    }
    function openReports(g) {
      const until = g.manifest.reportsHandledUntil || '';
      const removed = g.acc.removedReports || [];
      const out = [];
      Object.keys(g.digests).forEach(function (uid) {
        (g.digests[uid].reports || []).forEach(function (r) {
          if (r && r.reportedAt && !(until && r.reportedAt <= until) && removed.indexOf(r.factId + '|' + r.reportedAt) === -1) out.push({ factId: String(r.factId || ''), note: String(r.note || ''), reportedAt: r.reportedAt });
        });
      });
      return out.sort(function (a, b) { return a.reportedAt < b.reportedAt ? 1 : -1; });
    }

    async function summary(opts) {
      if (cache && !(opts && opts.force) && Date.now() - cacheAt < CACHE_MS) return cache;
      const g = await wrap(gather());
      const rows = rowsOf(g), t = todayVienna(), week = addDays(t, -6);
      const name = function (r) { return r.name || r.email || 'Unbekannt'; };
      const idle = rows.filter(function (r) { return r.unlocked && r.lastSeen && r.lastSeen < week; });
      const waiting = rows.filter(function (r) { return r.access === 'trialOver'; });
      const unpaid = rows.filter(function (r) { return r.access === 'open' && r.nextPay && r.nextPay < t; });
      let right = 0, total = 0;
      rows.forEach(function (r) { if (r.pct !== null) { right += r.pct * r.answered / 100; total += r.answered; } });
      const best = rows.slice().sort(function (a, b) { return b.streak - a.streak; })[0];
      const perDay = [];
      for (let i = 13; i >= 0; i--) {
        const d = addDays(t, -i);
        perDay.push({ date: d, active: rows.filter(function (r) { return r.active.indexOf(d) !== -1 || r.lastSeen === d && i === 0; }).length });
      }
      const areas = {};
      Object.keys(AREAS).forEach(function (k) { areas[k] = { name: AREAS[k], read: 0, answered: 0, right: 0 }; });
      Object.keys(g.digests).forEach(function (uid) {
        const acc = g.digests[uid].areaAccuracy || {};
        Object.keys(acc).forEach(function (k) {
          const a = acc[k], o = areas[k];
          if (!o || !a) return;
          o.read += a.read || 0; o.answered += a.answered || 0;
          if (a.pct !== null && a.answered) o.right += a.pct * a.answered / 100;
        });
      });
      const areaList = Object.keys(areas).map(function (k) {
        const o = areas[k];
        return { key: k, name: o.name, read: o.read, pct: o.answered ? Math.round(100 * o.right / o.answered) : null };
      });
      const reports = openReports(g);
      const run = g.manifest.lastRun || null;
      const factsUntil = g.manifest.lastDate || (run && run.lastDate) || '';
      const daysLeft = factsUntil ? daysBetween(t, factsUntil) : null;
      const runAge = run && run.at ? Math.floor((Date.now() - Date.parse(run.at)) / 86400000) : null;

      const usage = window.LumenUsage ? window.LumenUsage.assess(g.acc.usage, rows.length) : null;
      const unseen = g.acc.events.filter(function (e) { return !(g.acc.eventsSeenAt && e.at <= g.acc.eventsSeenAt); });
      const attention = [];
      if (usage && usage.verdict.level !== 'ok') attention.push({ level: usage.verdict.level, text: usage.verdict.title, link: link('usage') });
      else if (usage && usage.stale) attention.push({ level: 'info', text: usage.verdict.note, link: link('usage') });
      if (reports.length) attention.push({ level: 'warn', text: reports.length + ' offene Fehlermeldung' + (reports.length === 1 ? '' : 'en'), link: link('reports') });
      if (daysLeft !== null && daysLeft < 7) attention.push({ level: daysLeft < 3 ? 'alert' : 'warn', text: 'Fakten nur noch für ' + Math.max(0, daysLeft) + ' Tage', link: link('weekly') });
      if (runAge !== null && runAge > 8) attention.push({ level: 'warn', text: 'Wochenaufgabe lief seit ' + runAge + ' Tagen nicht', link: link('weekly') });
      if (waiting.length) attention.push({ level: 'warn', text: 'Wartet auf Freischaltung: ' + waiting.map(name).join(', '), link: link('billing') });
      if (unpaid.length) attention.push({ level: 'warn', text: 'Zahlung offen: ' + unpaid.map(name).join(', '), link: link('billing') });
      if (idle.length) attention.push({ level: 'info', text: 'Länger als eine Woche nicht da: ' + idle.map(name).join(', '), link: link('people') });

      cache = {
        project: INFO, at: new Date().toISOString(), today: t,
        people: {
          unlocked: rows.filter(function (r) { return r.unlocked; }).length, registered: rows.length,
          activeToday: rows.filter(function (r) { return r.lastSeen === t || r.active.indexOf(t) !== -1; }).length,
          active7: rows.filter(function (r) { return r.lastSeen >= week; }).length,
          reminders: g.pushOn, idle: idle.map(name), waiting: waiting.map(name), unpaid: unpaid.map(name),
          monthly: rows.reduce(function (n, r) { return n + (r.amount || 0); }, 0)
        },
        learning: {
          learned: rows.reduce(function (s, r) { return s + r.learned; }, 0), answered: total, pct: total ? Math.round(100 * right / total) : null,
          bestStreak: best && best.streak ? { name: name(best), days: best.streak } : null, perDay: perDay, areas: areaList
        },
        reports: { open: reports.length, items: reports.slice(0, 10) },
        content: { factsUntil: factsUntil, daysLeft: daysLeft, lastRun: run ? { at: run.at || '', added: run.added || 0, notes: run.notes || '' } : null, newsDate: (run && run.newsDate) || '' },
        notice: { text: (g.pub.notice && g.pub.notice.text) || '', at: (g.pub.notice && g.pub.notice.at) || '' },
        usage: usage,
        inbox: { unseen: unseen.length, latest: unseen.slice(-5).reverse() },
        attention: attention
      };
      cacheAt = Date.now();
      return cache;
    }
    async function people() {
      const g = await wrap(gather());
      return rowsOf(g).sort(function (a, b) { return a.lastSeen < b.lastSeen ? 1 : -1; });
    }

    /* ---------- everyday actions; everything bigger goes through link() to the admin page ---------- */
    async function setNotice(text) {
      guard();
      const clean = String(text || '').trim().slice(0, 400);
      if (!clean) throw fail('bad-input');
      await wrap(db.doc('config/public').set({ notice: { text: clean, at: new Date().toISOString() }, updatedAt: new Date().toISOString() }, { merge: true }));
      changed();
      return 'Mitteilung veröffentlicht.';
    }
    async function clearNotice() {
      guard();
      await wrap(db.doc('config/public').set({ notice: { text: '', at: new Date().toISOString() }, updatedAt: new Date().toISOString() }, { merge: true }));
      changed();
      return 'Mitteilung entfernt.';
    }
    /* Payment (lumen-billing.js): find the person by e-mail; amounts and paydays are set on the admin page. */
    async function personByEmail(email) {
      const e = norm(email && email.email !== undefined ? email.email : email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw fail('bad-input');
      const acc = await wrap(access());
      if (acc.adminEmails.indexOf(e) !== -1) throw fail('not-here');
      const snap = await wrap(db.collection('members').get());
      const hit = snap.docs.filter(function (d) { return norm((d.data() || {}).email) === e; })[0];
      if (!hit) throw fail('bad-input');
      return hit.id;
    }
    async function paid(email) {
      guard();
      const uid = await personByEmail(email);
      const cur = await wrap(db.doc('billing/' + uid).get());
      const b = cur.exists ? (cur.data() || {}) : {};
      if (b.status !== 'open') throw fail('not-here');
      const next = window.LumenBilling.afterPayment(b, todayVienna());
      await wrap(db.doc('billing/' + uid).set({ nextPay: next, paidAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true }));
      changed();
      return 'Bezahlt. Nächster Zahltag: ' + window.LumenBilling.longDate(next) + '.';
    }
    async function lock(input) {
      guard();
      const uid = await personByEmail(input);
      const message = String((input && input.message) || '').trim().slice(0, 400);
      await wrap(db.doc('billing/' + uid).set({ status: 'locked', message: message, lockedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true }));
      changed();
      return 'Zugang gesperrt.';
    }
    /* ---------- the inbox: messages from anything in Lumen (hourly watcher, workflows, the dashboard itself) ---------- */
    async function usage() {
      guard();
      const acc = await wrap(access());
      return window.LumenUsage ? window.LumenUsage.assess(acc.usage, null) : null;
    }
    async function events(opts) {
      guard();
      const o = opts || {}, acc = await wrap(access());
      let list = acc.events.map(function (e) { return Object.assign({}, e, { project: e.project || 'lumen', seen: !!(acc.eventsSeenAt && e.at <= acc.eventsSeenAt) }); });
      if (o.since) list = list.filter(function (e) { return e.at > o.since; });
      if (o.unseen) list = list.filter(function (e) { return !e.seen; });
      return list.sort(function (a, b) { return a.at < b.at ? 1 : -1; }).slice(0, o.limit || 60);
    }
    async function markSeen(at) {
      guard();
      await wrap(db.doc('config/access').set({ eventsSeenAt: at || new Date().toISOString() }, { merge: true }));
      changed();
      return 'Als gelesen markiert.';
    }
    async function send(e) {
      guard();
      const title = String((e && e.title) || '').trim().slice(0, 120);
      if (!title) throw fail('bad-input');
      const at = new Date().toISOString(), level = ['info', 'warn', 'alert'].indexOf(e.level) !== -1 ? e.level : 'info';
      const item = { id: 'dashboard-' + Date.parse(at).toString(36), key: 'dashboard|' + title + '|' + at, at: at, level: level, project: 'lumen',
        source: String(e.source || 'dashboard').slice(0, 30), title: title, text: String(e.text || '').slice(0, 400), link: String(e.link || '').slice(0, 300) };
      const acc = await wrap(access());
      await wrap(db.doc('config/access').set({ events: acc.events.concat([item]).slice(-60) }, { merge: true }));
      changed();
      return 'Meldung gespeichert.';
    }
    const ACTIONS = [
      { id: 'notice', label: 'Mitteilung an alle', input: 'text', hint: 'Erscheint oben auf „Heute“, max. 400 Zeichen', run: setNotice },
      { id: 'clearNotice', label: 'Mitteilung entfernen', input: null, run: clearNotice },
      { id: 'paid', label: 'Zahlung erhalten', input: 'email', hint: 'Schiebt den Zahltag einen Monat weiter', confirm: true, run: paid },
      { id: 'lock', label: 'Zugang sperren', input: 'email', hint: 'E-Mail oder { email, message }; die Nachricht sieht die Person beim Öffnen. Nicht für Admins.', confirm: true, run: lock }
    ];
    function run(id, input) {
      const a = ACTIONS.filter(function (x) { return x.id === id; })[0];
      if (!a) return Promise.reject(fail('unknown-action'));
      return a.run(input);
    }

    return {
      info: INFO,
      actions: ACTIONS.map(function (a) { return { id: a.id, label: a.label, input: a.input, hint: a.hint || '', confirm: !!a.confirm }; }),
      state: state,
      onChange: function (cb) { return auth.onAuthStateChanged(function () { changed(); state().then(cb); }); },
      signIn: function (email, password) { return wrap(auth.signInWithEmailAndPassword(String(email || '').trim(), String(password || ''))).then(function () { changed(); return state(); }); },
      reauth: function (password) {
        guard();
        if (!fb) return Promise.resolve();
        const cred = fb.auth.EmailAuthProvider.credential(user().email, String(password || ''));
        return wrap(user().reauthenticateWithCredential(cred).then(function () { return user().getIdToken(true); })).then(function () { changed(); return state(); });
      },
      signOut: function () { changed(); return auth.signOut(); },
      summary: summary,
      usage: usage,
      events: events,
      markSeen: markSeen,
      send: send,
      people: people,
      run: run,
      link: link
    };
  }

  /* Deep links into the admin page: overview, people (optionally one person), settings, facts, reports, weekly. */
  function link(section, id) {
    const s = ADMIN_SECTIONS.indexOf(section) !== -1 ? section : 'overview';
    return BASE + 'admin.html#' + s + (id ? '/' + encodeURIComponent(id) : '');
  }

  window.LumenConnect = { contract: CONTRACT, info: INFO, connect: connect, link: link };
})();

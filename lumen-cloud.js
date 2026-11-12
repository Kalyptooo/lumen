/* Lumen cloud layer, shared by index.html (learning) and admin.html (admin).
   - Firebase Authentication (email and password) and Firestore for personal data.
   - The facts, "Aktuell" and the topic lists are static JSON files in data/, written by the weekly task.
   The local preview (tests/dev-server.mjs) defines window.LumenCloud with a fake auth and db first;
   this file then only adds the content loader and the messages. */
(function () {
  'use strict';
  const out = window.LumenCloud || { ready: false, auth: null, db: null, firebase: null };
  const fake = !!out.fake;

  /* ---------- static content ---------- */

  function makeContent(base) {
    let manifest = null, manifestAt = 0, manifestReq = null;
    const cache = {};
    const v = function () { return manifest && manifest.updatedAt ? '?v=' + encodeURIComponent(manifest.updatedAt) : ''; };
    function getJSON(url, fresh) {
      return fetch(url, { cache: fresh ? 'no-cache' : 'default' }).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    function loadManifest(force) {
      if (manifest && !force && Date.now() - manifestAt < 300000) return Promise.resolve(manifest);
      if (manifestReq) return manifestReq;
      manifestReq = getJSON(base + 'manifest.json?t=' + Date.now(), true).then(function (m) {
        manifest = m || { days: [], news: [], idx: [], runs: [] };
        manifestAt = Date.now();
        manifestReq = null;
        return manifest;
      }, function (e) { manifestReq = null; throw e; });
      return manifestReq;
    }
    function file(dir, name) {
      const key = dir + '/' + name;
      if (!cache[key]) {
        cache[key] = getJSON(base + key + '.json' + v()).catch(function (e) { delete cache[key]; throw e; });
      }
      return cache[key];
    }
    const has = function (list, name) { return Array.isArray(list) && list.indexOf(name) !== -1; };
    return {
      manifest: loadManifest,
      day: function (date) {
        return loadManifest().then(function (m) { return has(m.days, date) ? file('facts', date) : null; });
      },
      range: function (from, to) {
        return loadManifest().then(function (m) {
          const dates = (m.days || []).filter(function (d) { return d >= from && d <= to; });
          return Promise.all(dates.map(function (d) { return file('facts', d); })).then(function (docs) {
            const win = {};
            docs.forEach(function (doc) { if (doc && doc.date) win[doc.date] = doc; });
            return win;
          });
        });
      },
      before: function (date, n) {
        return loadManifest().then(function (m) {
          const dates = (m.days || []).filter(function (d) { return d <= date; }).sort().reverse().slice(0, n);
          return Promise.all(dates.map(function (d) { return file('facts', d); })).then(function (docs) { return docs.filter(Boolean); });
        });
      },
      upTo: function (date) {
        return loadManifest().then(function (m) {
          const dates = (m.days || []).filter(function (d) { return d <= date; }).sort();
          return Promise.all(dates.map(function (d) { return file('facts', d); })).then(function (docs) { return docs.filter(Boolean); });
        });
      },
      idx: function () {
        return loadManifest().then(function (m) {
          return Promise.all((m.idx || []).map(function (id) {
            return file('idx', id).then(function (doc) { return doc ? Object.assign({ id: id }, doc) : null; });
          })).then(function (docs) { return docs.filter(Boolean); });
        });
      },
      news: function (n) {
        return loadManifest().then(function (m) {
          const dates = (m.news || []).slice().sort().reverse().slice(0, n);
          return Promise.all(dates.map(function (d) { return file('news', d); })).then(function (docs) { return docs.filter(Boolean); });
        });
      }
    };
  }

  /* ---------- Firebase ---------- */

  out.content = makeContent('data/');
  out.errorText = {
    'auth/invalid-credential': 'E-Mail oder Passwort stimmt nicht.',
    'auth/invalid-login-credentials': 'E-Mail oder Passwort stimmt nicht.',
    'auth/wrong-password': 'E-Mail oder Passwort stimmt nicht.',
    'auth/user-not-found': 'E-Mail oder Passwort stimmt nicht.',
    'auth/invalid-email': 'Diese E-Mail-Adresse ist ungültig.',
    'auth/missing-email': 'Bitte gib deine E-Mail-Adresse ein.',
    'auth/missing-password': 'Bitte gib dein Passwort ein.',
    'auth/email-already-in-use': 'Für diese E-Mail-Adresse gibt es schon ein Konto. Melde dich an oder setze das Passwort zurück.',
    'auth/weak-password': 'Das Passwort ist zu kurz. Nimm mindestens 8 Zeichen.',
    'auth/too-many-requests': 'Zu viele Versuche. Bitte warte ein paar Minuten.',
    'auth/network-request-failed': 'Keine Verbindung. Prüfe dein Internet und versuche es noch einmal.',
    'auth/user-disabled': 'Dieses Konto ist gesperrt.'
  };
  out.message = function (e) {
    return (e && out.errorText[e.code]) || 'Das hat gerade nicht geklappt. Bitte versuche es noch einmal.';
  };

  try {
    const fb = window.firebase;
    if (!fake && fb && window.LUMEN_FIREBASE) {
      const app = fb.apps.length ? fb.app() : fb.initializeApp(window.LUMEN_FIREBASE);
      out.firebase = fb;
      out.auth = app.auth();
      out.auth.languageCode = 'de';
      out.db = app.firestore();
      out.db.enablePersistence({ synchronizeTabs: true }).catch(function () { /* private mode or old browser: works online only */ });
      out.ready = true;
    }
  } catch (e) { out.ready = false; }

  window.LumenCloud = out;
})();

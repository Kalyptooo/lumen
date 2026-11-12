/* Fake Firebase for the local preview only (injected by tests/dev-server.mjs, never published as part of the pages).
   URL parameters: scene=signin|verify|denied|ready (default ready), admin=1 (signed-in user is admin), seed=1 (load the
   private backup from the dev server), reset=1 (forget the stored fake data). Data lives in sessionStorage. */
(function () {
  'use strict';
  const p = new URLSearchParams(location.search);
  const scene = p.get('scene') || 'ready';
  const KEY = 'lumen-fake-store';
  if (p.get('reset')) sessionStorage.removeItem(KEY);
  let store = {};
  try { store = JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch (e) { store = {}; }
  const save = function () { sessionStorage.setItem(KEY, JSON.stringify(store)); };
  const isObj = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
  function merge(base, patch) {
    const out = isObj(base) ? Object.assign({}, base) : {};
    Object.keys(patch).forEach(function (k) { out[k] = isObj(patch[k]) ? merge(out[k], patch[k]) : patch[k]; });
    return out;
  }
  const clone = function (o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); };
  const err = function (code) { const e = new Error(code); e.code = code; return e; };
  const delay = function (v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 60); }); };

  const UID = 'fake-uid-1';
  function mkUser(email, verified) {
    return {
      uid: UID, email: email, displayName: p.get('name') || 'Test', emailVerified: verified,
      reload: function () { return delay(); }, getIdToken: function () { return delay('t'); },
      sendEmailVerification: function () { return delay(); },
      updateProfile: function (x) { Object.assign(this, x); return delay(); }
    };
  }
  let user = scene === 'signin' ? null : mkUser('test@example.com', scene !== 'verify');
  const authCbs = [];
  const fire = function () { authCbs.forEach(function (cb) { cb(user); }); };
  const auth = {
    get currentUser() { return user; },
    onAuthStateChanged: function (cb) { authCbs.push(cb); setTimeout(function () { cb(user); }, 80); return function () {}; },
    signInWithEmailAndPassword: function (email, pw) {
      if (pw !== 'testtest') return Promise.reject(err('auth/invalid-credential'));
      user = mkUser(email, true); setTimeout(fire, 0); return delay({ user: user });
    },
    createUserWithEmailAndPassword: function (email) { user = mkUser(email, false); setTimeout(fire, 0); return delay({ user: user }); },
    sendPasswordResetEmail: function () { return delay(); },
    signOut: function () { user = null; setTimeout(fire, 0); return delay(); }
  };

  const allowed = function (path) {
    if (scene === 'denied') return false;
    if (/^config\/access/.test(path) || /^(members|digest)$/.test(path)) return p.get('admin') === '1';
    return true;
  };
  const listeners = [];
  function notify() { listeners.forEach(function (l) { l(); }); }
  function snapOfCollection(path) {
    const prefix = path + '/';
    const docs = Object.keys(store).filter(function (k) { return k.indexOf(prefix) === 0 && k.slice(prefix.length).indexOf('/') === -1; })
      .sort().map(function (k) { const d = clone(store[k]); return { id: k.slice(prefix.length), data: function () { return d; } }; });
    return { docs: docs, size: docs.length, metadata: { fromCache: false } };
  }
  const db = {
    doc: function (path) {
      return {
        id: path.split('/').pop(),
        get: function () {
          if (!allowed(path)) return Promise.reject(err('permission-denied'));
          const d = clone(store[path]);
          return delay({ exists: d !== undefined, id: path.split('/').pop(), data: function () { return d; } });
        },
        set: function (data, opts) {
          if (!allowed(path)) return Promise.reject(err('permission-denied'));
          store[path] = opts && opts.merge ? merge(store[path], clone(data)) : clone(data);
          save();
          return delay().then(notify);
        },
        delete: function () { delete store[path]; save(); return delay().then(notify); }
      };
    },
    collection: function (path) {
      return {
        get: function () { return allowed(path) ? delay(snapOfCollection(path)) : Promise.reject(err('permission-denied')); },
        onSnapshot: function (a, b, c) {
          const next = typeof a === 'function' ? a : b, onErr = typeof a === 'function' ? b : c;
          if (!allowed(path)) { setTimeout(function () { onErr(err('permission-denied')); }, 60); return function () {}; }
          const l = function () { next(snapOfCollection(path)); };
          listeners.push(l);
          setTimeout(l, 60);
          return function () { const i = listeners.indexOf(l); if (i !== -1) listeners.splice(i, 1); };
        }
      };
    }
  };

  let seeded = Promise.resolve();
  if (p.get('seed') && !store['seeded']) {
    seeded = fetch('/__seed').then(function (r) { return r.ok ? r.json() : null; }).then(function (b) {
      if (!b || !b.learning) return;
      Object.keys(b.learning).forEach(function (k) { store['data/users/' + UID + '/' + k] = b.learning[k]; });
      if (b.digest) store['digest/' + UID] = b.digest;
      store['seeded'] = true;
      save();
    }).catch(function () {});
  }
  if (p.get('admin') === '1' && !store['config/access']) {
    store['config/access'] = { adminEmails: ['test@example.com'], invited: ['anna@example.com'] };
    store['members/' + UID] = { email: 'test@example.com', name: 'Test', lastSeen: '2026-11-12' };
    store['members/other-2'] = { email: 'anna@example.com', name: 'Anna', lastSeen: '2026-11-10' };
    store['digest/other-2'] = { seenCount: 12, streak: 2, lastDay: '2026-11-10', knownIds: ['2026-11-11-1'],
      areaAccuracy: { geld: { read: 3, answered: 4, pct: 75 } }, reports: [{ factId: '2026-11-12-2', note: 'Zahl stimmt nicht', reportedAt: '2026-11-11T08:00:00.000Z' }], updatedAt: '2026-11-10T19:00:00.000Z' };
    save();
  }
  const origOn = auth.onAuthStateChanged;
  auth.onAuthStateChanged = function (cb) { seeded.then(function () { origOn(cb); }); return function () {}; };

  window.LumenCloud = { fake: true, ready: true, auth: auth, db: db, firebase: null };
})();

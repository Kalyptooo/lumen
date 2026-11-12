/* Lumen service worker.
   - Offline: pages, scripts and content are served from the network when possible and from the cache otherwise.
   - Reminders: Firebase Cloud Messaging shows the notifications sent by tools/send-reminders.mjs. */
const CACHE = 'lumen-v1';
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
const SHELL = ['./', 'index.html', 'lumen-cloud.js', 'firebase-config.js', 'manifest.webmanifest', 'icon-180.png', 'icon.svg',
  SDK + 'firebase-app-compat.js', SDK + 'firebase-auth-compat.js', SDK + 'firebase-firestore-compat.js', SDK + 'firebase-messaging-compat.js'];

try {
  importScripts(SDK + 'firebase-app-compat.js', SDK + 'firebase-messaging-compat.js', 'firebase-config.js');
  firebase.initializeApp(self.LUMEN_FIREBASE);
  firebase.messaging();
} catch (e) { /* offline at install time or push not supported: caching still works */ }

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(SHELL.map(function (url) { return cache.add(url).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(request) {
  return fetch(request).then(function (res) {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(request, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(request, { ignoreSearch: true }).then(function (hit) {
      return hit || (request.mode === 'navigate' ? caches.match('index.html') : undefined) || Response.error();
    });
  });
}
function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    return hit || fetch(request).then(function (res) {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(request, copy); }); }
      return res;
    });
  });
}
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.indexOf('/tests/') !== -1) return;
    event.respondWith(networkFirst(req));
  } else if (url.href.indexOf(SDK) === 0) {
    event.respondWith(cacheFirst(req));
  }
  // Everything else (Firebase sign-in and database) goes straight to the network; Firestore keeps its own offline copy.
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});

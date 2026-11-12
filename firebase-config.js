// Firebase project "lumen" (Spark plan, Firestore in europe-west3 Frankfurt).
// These values identify the project; they are public by design and not a secret.
// Access is protected by the Firestore security rules (firestore.rules) and Firebase Authentication.
// `self` works both in the page and in the service worker (sw.js).
self.LUMEN_FIREBASE = {
  apiKey: 'AIzaSyDO8Nkf59DHSWsz0033L-Q-qLvXBFnleNo',
  authDomain: 'lumen-f76be.firebaseapp.com',
  projectId: 'lumen-f76be',
  storageBucket: 'lumen-f76be.firebasestorage.app',
  messagingSenderId: '694515569340',
  appId: '1:694515569340:web:17bba6b1cefb79807976b9'
};
// Public key for web push (Firebase console > Project settings > Cloud Messaging). Public, not a secret.
self.LUMEN_VAPID = 'BEhSMumOvO7KVuk8rvfmaH4W6sqDl26T48a4MYI9B5tjQSoQmjHummdxDDbM4_eDzbtvvp8OaQJeU4_9HUCfD3o';

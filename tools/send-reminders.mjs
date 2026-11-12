// Sends Lumen reminders through Firebase Cloud Messaging. Run by .github/workflows/reminders.yml every 15 minutes.
// Needs the GitHub secret FIREBASE_SA (the JSON key of the Firebase service account). Without it, it does nothing.
// Per person (Firestore push/<uid>): at each stage time (morgen, mittag, abend) one notification, only while that stage
// is still open today, at most one per run, never twice for the same stage on the same day.
import crypto from 'node:crypto';

const SITE = 'https://kalyptooo.github.io/lumen/';
const DEFAULT_TIMES = { morgen: '07:00', mittag: '12:00', abend: '18:00' };
const TEXT = {
  morgen: 'Guten Morgen. Die Wiederholung und dein erster Fakt warten.',
  mittag: 'Mittag: Ein neuer Fakt wartet auf dich.',
  abend: 'Abend: Die letzten Fakten des Tages warten auf dich.'
};
const LATE = 180; // minutes after the stage time in which a reminder still makes sense

if (!process.env.FIREBASE_SA) { console.log('FIREBASE_SA fehlt: keine Erinnerungen gesendet.'); process.exit(0); }
const sa = JSON.parse(process.env.FIREBASE_SA);
const project = sa.project_id;
const DB = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

const b64url = (s) => Buffer.from(s).toString('base64url');
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging'
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` })
  });
  if (!res.ok) throw new Error('Anmeldung beim Dienstkonto fehlgeschlagen: ' + res.status);
  return (await res.json()).access_token;
}
function plain(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]));
  return v;
}
function vienna() {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const minutesOf = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

const token = await accessToken();
const auth = { authorization: `Bearer ${token}` };
const now = vienna();

let factsToday = true;
try {
  const m = await (await fetch(SITE + 'data/manifest.json?t=' + Date.now())).json();
  factsToday = Array.isArray(m.days) && m.days.includes(now.date);
} catch (e) { /* if the manifest is unreachable, remind anyway */ }

const list = await (await fetch(`${DB}/push?pageSize=300`, { headers: auth })).json();
let sentCount = 0;
for (const doc of list.documents || []) {
  const uid = doc.name.split('/').pop();
  const p = plain({ mapValue: { fields: doc.fields || {} } });
  if (!p.enabled || !p.token) continue;
  const times = Object.assign({}, DEFAULT_TIMES, p.times || {});
  const sent = p.sent && p.sent.date === now.date ? (p.sent.blocks || []) : [];
  const due = ['morgen', 'mittag', 'abend'].filter((b) => {
    const t = minutesOf(times[b]);
    return t !== null && now.minutes >= t && now.minutes < t + LATE && !sent.includes(b);
  });
  if (!due.length) continue;
  // Which stages are already done today?
  let done = [];
  try {
    const m = await (await fetch(`${DB}/data/users/${uid}/m_${now.date.slice(0, 7)}`, { headers: auth })).json();
    const day = plain({ mapValue: { fields: m.fields || {} } }).days?.[now.date] || {};
    done = day.blocksDone || [];
  } catch (e) { /* no month document yet */ }
  const open = due.filter((b) => !done.includes(b));
  const block = open[open.length - 1];
  let enabled = true;
  if (block && factsToday) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: p.token, webpush: {
        notification: { title: 'Lumen', body: TEXT[block], icon: SITE + 'icon-180.png', tag: 'lumen-' + block },
        fcm_options: { link: SITE }
      } } })
    });
    if (res.ok) sentCount += 1;
    else {
      const err = await res.text();
      if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(err)) enabled = false;
      console.log(`Senden an ${uid.slice(0, 6)}… fehlgeschlagen: ${res.status}`);
    }
  }
  const blocks = sent.concat(due);
  const fields = { sent: { mapValue: { fields: { date: { stringValue: now.date }, blocks: { arrayValue: { values: blocks.map((b) => ({ stringValue: b })) } } } } } };
  let mask = 'updateMask.fieldPaths=sent';
  if (!enabled) { fields.enabled = { booleanValue: false }; mask += '&updateMask.fieldPaths=enabled'; }
  await fetch(`${DB}/push/${uid}?${mask}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ fields }) });
}
console.log(`${now.date} ${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')} · ${sentCount} Erinnerung(en) gesendet`);

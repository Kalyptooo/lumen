// Payment reminders (concept: lumen-billing.js). Run by .github/workflows/reminders.yml; does its work once a day from 09:00 Vienna.
// Per unlocked person with a payday (billing/<uid>.nextPay):
//   on the payday: a reminder to the person (if billing.remindPush is not false) and to the admins;
//   two weeks later, if still not marked as paid: a second reminder to the admins (lock the person by hand if needed).
// Admin reminders go to the admins' phones and to the inbox "Meldungen" (config/access.events).
// Nobody is ever locked automatically here. E-mail reminders are not set up yet (billing.remindEmail is only stored).
import { createRequire } from 'node:module';
import { serviceAccount, accessToken, fieldsOf, patchFields } from './fb-rest.mjs';
import { mergeEvents } from './notify.mjs';
const Billing = createRequire(import.meta.url)('../lumen-billing.js');

const SITE = 'https://kalyptooo.github.io/lumen/';
const FROM_MINUTES = 9 * 60;

const sa = serviceAccount();
if (!sa) { console.log('FIREBASE_SA fehlt: keine Zahltag-Erinnerungen.'); process.exit(0); }
const DB = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
const auth = { authorization: `Bearer ${await accessToken(sa)}` };

const p = {};
for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) p[x.type] = x.value;
const today = `${p.year}-${p.month}-${p.day}`;
if (Number(p.hour) * 60 + Number(p.minute) < FROM_MINUTES) { console.log('Zahltage: erst ab 9 Uhr.'); process.exit(0); }

// Once a day is enough: config/billing.checkedOn remembers the last day (one read per run instead of all people).
const cfgUrl = `${DB}/config/billing`;
const cfg = fieldsOf(await (await fetch(cfgUrl, { headers: auth })).json());
if (cfg.checkedOn === today) { console.log('Zahltage: heute schon geprüft.'); process.exit(0); }

const list = async (name) => {
  const out = {};
  const got = await (await fetch(`${DB}/${name}?pageSize=300`, { headers: auth })).json();
  for (const d of got.documents || []) out[d.name.split('/').pop()] = fieldsOf(d);
  return out;
};
const bills = await list('billing');
const owed = Object.entries(bills).flatMap(([uid, b]) => Billing.reminders(b, today).map((r) => ({ uid, b, ...r })));

if (owed.length) {
  const [members, pushes] = await Promise.all([list('members'), list('push')]);
  const accUrl = `${DB}/config/access`;
  const acc = fieldsOf(await (await fetch(accUrl, { headers: auth })).json());
  const adminEmails = (acc.adminEmails || []).map((e) => String(e).toLowerCase());
  const adminUids = Object.keys(members).filter((uid) => adminEmails.includes(String(members[uid].email || '').toLowerCase()));
  const send = async (uid, body, tag, link) => {
    const t = pushes[uid];
    if (!t || !t.token) return false;
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: t.token, webpush: { headers: { Urgency: 'high' },
        notification: { title: 'Lumen', body, icon: SITE + 'icon-180.png', tag }, fcm_options: { link } } } })
    });
    if (!res.ok) console.log(`Senden an ${uid.slice(0, 6)}… fehlgeschlagen: ${res.status}`);
    return res.ok;
  };
  const events = [];
  for (const o of owed) {
    const m = members[o.uid] || {};
    const who = m.name || m.email || 'Jemand';
    const amount = Number(o.b.amount) > 0 ? Billing.euro(o.b.amount) : 'der Beitrag';
    const adminLink = SITE + 'admin.html#billing/' + o.uid;
    if (o.kind === 'due') {
      if (o.b.remindPush !== false) await send(o.uid, `Heute ist Zahltag: Bitte überweise ${amount} für Lumen.`, 'lumen-pay', SITE);
      for (const a of adminUids) await send(a, `Zahltag von ${who}: ${amount}. Noch nicht als bezahlt markiert.`, 'lumen-pay-' + o.uid, adminLink);
      events.push({ level: 'info', title: `Zahltag: ${who}`, text: `${amount} sind heute fällig. Wenn das Geld da ist, im Admin-Bereich „Zahlung erhalten“ antippen.`, link: adminLink, source: 'zahltag', key: `zahltag|${o.uid}|${o.due}|1` });
    } else {
      for (const a of adminUids) await send(a, `${who} hat seit zwei Wochen nicht bezahlt (${amount}). Zugang sperren?`, 'lumen-pay-' + o.uid, adminLink);
      events.push({ level: 'warn', title: `Seit 2 Wochen offen: ${who}`, text: `${amount}, fällig seit ${Billing.longDate(o.due)}. Wenn nicht bezahlt wurde, kannst du den Zugang im Admin-Bereich sperren.`, link: adminLink, source: 'zahltag', key: `zahltag|${o.uid}|${o.due}|2` });
    }
    await patchFields(`${DB}/billing/${o.uid}`, auth, o.kind === 'due' ? { remind1: o.due } : { remind2: o.due });
  }
  const merged = mergeEvents(acc.events, events);
  if (merged.added.length) await patchFields(accUrl, auth, { events: merged.events });
}
await patchFields(cfgUrl, auth, { checkedOn: today });
console.log(`Zahltage ${today}: ${owed.length} Erinnerung(en).`);

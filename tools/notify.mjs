// Messages for the dashboard inbox ("Meldungen"). Anything in Lumen can send one; the dashboard collects them
// through lumen-connect.js (lumen.events()) next to the messages of other projects.
// Stored in config/access.events (admins only), newest last, at most 60, no duplicates per `key`.
//
// From a terminal or a workflow step (needs the GitHub secret FIREBASE_SA):
//   node tools/notify.mjs <info|warn|alert> "Titel" "Text" [Link] [Quelle]
// From a script:
//   import { mergeEvents } from './notify.mjs';
import { pathToFileURL } from 'node:url';
import { serviceAccount, accessToken, fieldsOf, patchFields } from './fb-rest.mjs';

export const MAX_EVENTS = 60;
const LEVELS = ['info', 'warn', 'alert'];

/* One clean message. key: same key = same message, sent only once. */
export function makeEvent(e, now = Date.now()) {
  const at = e.at || new Date(now).toISOString();
  const level = LEVELS.includes(e.level) ? e.level : 'info';
  const title = String(e.title || '').trim().slice(0, 120);
  if (!title) return null;
  return {
    id: (e.key || title).replace(/[^\w-]+/g, '-').slice(0, 60) + '-' + Date.parse(at).toString(36),
    key: String(e.key || title + '|' + at).slice(0, 160), at, level, project: 'lumen', source: String(e.source || 'lumen').slice(0, 30),
    title, text: String(e.text || '').trim().slice(0, 400), link: String(e.link || '').slice(0, 300)
  };
}
/* Adds new messages to the list: skips keys already present, keeps the newest MAX_EVENTS. */
export function mergeEvents(old, add, now = Date.now()) {
  const list = Array.isArray(old) ? old.filter((e) => e && e.key) : [];
  const keys = new Set(list.map((e) => e.key));
  const fresh = [];
  for (const raw of add || []) {
    const e = makeEvent(raw, now);
    if (!e || keys.has(e.key)) continue;
    keys.add(e.key);
    fresh.push(e);
  }
  return { events: list.concat(fresh).sort((a, b) => (a.at < b.at ? -1 : 1)).slice(-MAX_EVENTS), added: fresh };
}

async function main() {
  const [level, title, text = '', link = '', source = 'manuell'] = process.argv.slice(2);
  if (!title) { console.log('Aufruf: node tools/notify.mjs <info|warn|alert> "Titel" "Text" [Link] [Quelle]'); process.exit(1); }
  const sa = serviceAccount();
  if (!sa) { console.log('FIREBASE_SA fehlt: Meldung nicht gesendet.'); process.exit(0); }
  const auth = { authorization: `Bearer ${await accessToken(sa)}` };
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/config/access`;
  const cur = fieldsOf(await (await fetch(url, { headers: auth })).json());
  const out = mergeEvents(cur.events, [{ level, title, text, link, source, key: source + '|' + title + '|' + new Date().toISOString().slice(0, 13) }]);
  if (!out.added.length) { console.log('Gleiche Meldung gab es in dieser Stunde schon.'); return; }
  await patchFields(url, auth, { events: out.events });
  console.log('Meldung gesendet: ' + title);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

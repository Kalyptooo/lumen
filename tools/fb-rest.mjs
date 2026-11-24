// Small helpers for the Firestore REST API with the service account in FIREBASE_SA (GitHub secret).
import crypto from 'node:crypto';

export function serviceAccount() {
  if (!process.env.FIREBASE_SA) return null;
  return JSON.parse(process.env.FIREBASE_SA);
}
export async function accessToken(sa, scope = 'https://www.googleapis.com/auth/cloud-platform') {
  const b64url = (s) => Buffer.from(s).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000, scope }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` })
  });
  if (!res.ok) throw new Error('Anmeldung beim Dienstkonto fehlgeschlagen: ' + res.status);
  return (await res.json()).access_token;
}
export function plain(v) {
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
export function typed(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(typed) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typed(x)])) } };
}
export const fieldsOf = (doc) => plain({ mapValue: { fields: (doc && doc.fields) || {} } });
/* Writes only the named top-level fields of a document. */
export async function patchFields(url, auth, data) {
  const mask = Object.keys(data).map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typed(v)]));
  const res = await fetch(`${url}?${mask}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ fields }) });
  if (!res.ok) throw new Error('Speichern fehlgeschlagen: ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

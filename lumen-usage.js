/* How full are the free limits? Turns the measurements of tools/usage-report.mjs (config/access.usage) into plain
   statements: per limit how much is used, whether it gets tight, how long it lasts, and one overall verdict.
   Used by admin.html (tab "Auslastung") and lumen-connect.js (dashboard). Pure functions, tested in tests/logic.test.mjs. */
(function (root) {
  'use strict';
  const GIB = 1024 * 1024 * 1024;
  const LIMITS = { reads: 50000, writes: 20000, deletes: 20000, storage: GIB, site: 1e9 };
  const WARN = 60, ALERT = 85;
  // Services with nothing to measure: free and far away from any limit at this size.
  const FREE = [
    ['Push-Nachrichten (Firebase Cloud Messaging)', 'Kostenlos und ohne Mengengrenze.'],
    ['Erinnerungs-Ablauf (GitHub Actions)', 'Kostenlos, weil das Archiv öffentlich ist.'],
    ['Takt (cron-job.org)', 'Kostenlos.'],
    ['Datenverkehr der Datenbank', '10 GiB im Monat frei. Lumen überträgt nur kleine Textmengen, das ist weit weg.'],
    ['Datenverkehr der Website (GitHub Pages)', 'Etwa 100 GB im Monat frei. Bei dieser Gruppengröße weit weg.'],
    ['Wochenaufgabe', 'Läuft über dein Claude-Abo. Dessen Nutzung zeigt claude.ai, nicht diese Seite.']
  ];
  const num = function (n) { return Math.round(n).toLocaleString('de-AT'); };
  function bytes(n) {
    if (n >= GIB) return (n / GIB).toLocaleString('de-AT', { maximumFractionDigits: 2 }) + ' GB';
    if (n >= 1048576) return (n / 1048576).toLocaleString('de-AT', { maximumFractionDigits: 1 }) + ' MB';
    return Math.max(1, Math.round(n / 1024)).toLocaleString('de-AT') + ' KB';
  }
  const levelOf = function (pct) { return pct >= ALERT ? 'alert' : pct >= WARN ? 'warn' : 'ok'; };
  const pctOf = function (used, limit) { return limit ? Math.round(1000 * used / limit) / 10 : 0; };
  function span(days) {
    if (days > 3650) return 'mehr als 10 Jahren';
    if (days > 730) return 'etwa ' + Math.round(days / 365) + ' Jahren';
    if (days > 60) return 'etwa ' + Math.round(days / 30) + ' Monaten';
    return 'etwa ' + Math.max(1, Math.round(days)) + ' Tagen';
  }
  /* Growth per day from a [{date, bytes}] history; null while it is too short to say. */
  function growth(history) {
    const h = (history || []).filter(function (x) { return x && x.date && x.bytes >= 0; });
    if (h.length < 2) return null;
    const first = h[0], last = h[h.length - 1];
    const days = (Date.parse(last.date) - Date.parse(first.date)) / 86400000;
    return days >= 1 ? (last.bytes - first.bytes) / days : null;
  }
  function sizeItem(key, name, data, limit) {
    if (!data || !(data.bytes >= 0)) return { key: key, name: name, level: 'unknown', text: 'Noch nicht gemessen.' };
    const pct = pctOf(data.bytes, limit), g = growth(data.history);
    let forecast = 'Wie schnell es wächst, steht nach ein paar Tagen Messung fest.';
    if (g !== null && g <= 0) forecast = 'Wächst gerade nicht.';
    else if (g !== null) forecast = 'Wächst um etwa ' + bytes(g * 30) + ' im Monat. Voll in ' + span((limit - data.bytes) / g) + '.';
    let level = levelOf(pct);
    if (g !== null && g > 0 && (limit - data.bytes) / g < 90 && level === 'ok') level = 'warn';
    return { key: key, name: name, used: data.bytes, limit: limit, pct: pct, level: level, text: bytes(data.bytes) + ' von ' + (limit === 1e9 ? '1 GB' : bytes(limit)), forecast: forecast };
  }

  /* usage: config/access.usage; people: registered people (for "how many people fit"); now: ms (tests). */
  function assess(usage, people, now) {
    now = now || Date.now();
    const u = usage || {};
    const items = [];
    const fs = u.firestore, days = (fs && fs.days) || [];
    const today = fs && days.filter(function (d) { return d.date === fs.today; })[0];
    const ops = [['reads', 'Lesen aus der Datenbank', 'Lesungen'], ['writes', 'Schreiben in die Datenbank', 'Schreibvorgänge'], ['deletes', 'Löschen in der Datenbank', 'Löschvorgänge']];
    ops.forEach(function (o) {
      const key = o[0], limit = LIMITS[key];
      if (!today) {
        items.push({ key: key, name: o[1], level: 'unknown', text: u.monitoring && u.monitoring.error ? 'Noch keine Zahlen: Zugriff fehlt.' : 'Noch nicht gemessen.' });
        return;
      }
      const peak = Math.max.apply(null, days.map(function (d) { return d[key] || 0; }).concat([0]));
      const used = today[key] || 0, pct = pctOf(used, limit), peakPct = pctOf(peak, limit);
      const item = { key: key, name: o[1], used: used, limit: limit, pct: pct, peak: peak, level: levelOf(Math.max(pct, peakPct)),
        text: num(used) + ' von ' + num(limit) + ' heute', forecast: 'Höchster Tag der letzten Woche: ' + num(peak) + ' (' + peakPct.toLocaleString('de-AT') + ' %).' };
      if (key !== 'deletes' && people > 0 && peak > 0) {
        const per = peak / people, fit = Math.floor(limit * 0.8 / per);
        item.perPerson = Math.round(per);
        item.forecast += ' Etwa ' + num(per) + ' ' + o[2] + ' pro Person und Tag, Platz für rund ' + num(fit) + ' Personen.';
        if (fit < people * 1.5 && item.level === 'ok') item.level = 'warn';
      }
      items.push(item);
    });
    items.push(sizeItem('storage', 'Gespeicherte Daten', u.storage, LIMITS.storage));
    items.push(sizeItem('site', 'Website-Größe (GitHub Pages)', u.site, LIMITS.site));
    if (u.accounts !== null && u.accounts !== undefined) {
      items.push({ key: 'accounts', name: 'Konten', used: u.accounts, level: 'ok', text: num(u.accounts) + ' Konten', forecast: 'Die kostenlose Grenze liegt bei Zehntausenden Nutzern.' });
    }
    const age = u.at ? (now - Date.parse(u.at)) / 3600000 : null;
    const stale = age === null || age > 3;
    const lacksAccess = !!(u.monitoring && !u.monitoring.ok && u.monitoring.error);
    const tight = items.filter(function (i) { return i.level === 'alert'; }), watch = items.filter(function (i) { return i.level === 'warn'; });
    let verdict;
    if (tight.length) verdict = { level: 'alert', title: 'Es wird eng: ' + tight.map(function (i) { return i.name; }).join(', '),
      text: 'Bitte bald handeln. Meist lässt sich Lumen sparsamer machen, bevor ein Upgrade nötig ist. Ein Upgrade wäre der kostenpflichtige Blaze-Tarif.' };
    else if (watch.length) verdict = { level: 'warn', title: 'Im Blick behalten: ' + watch.map(function (i) { return i.name; }).join(', '),
      text: 'Noch kein Upgrade nötig, aber das nähert sich der Grenze.' };
    else verdict = { level: 'ok', title: 'Alles im grünen Bereich', text: 'Kein Upgrade nötig. Alles läuft im kostenlosen Rahmen.' };
    if (stale) verdict.note = age === null ? 'Es gibt noch keine Messung. Sie läuft einmal pro Stunde mit den Erinnerungen.' :
      'Die letzte Messung ist ' + Math.round(age) + ' Stunden alt. Läuft der Takt bei cron-job.org noch?';
    return { at: u.at || '', ageHours: age, stale: stale, lacksAccess: lacksAccess, accessError: lacksAccess ? u.monitoring.error : '',
      resetNote: 'Die Tageszahlen der Datenbank beginnen jeden Tag um 9 Uhr früh neu (Mitternacht in Kalifornien).',
      verdict: verdict, items: items, free: FREE.map(function (f) { return { name: f[0], text: f[1] }; }) };
  }

  const api = { assess: assess, bytes: bytes, LIMITS: LIMITS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LumenUsage = api;
})(typeof self !== 'undefined' ? self : this);

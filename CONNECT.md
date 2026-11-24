# Dashboard-Anschluss (Vertrag Version 1)

Lumen lässt sich in ein eigenes Dashboard einbinden. Das Dashboard bekommt die wichtigsten Zahlen, kann die alltäglichen Admin-Aufgaben direkt erledigen und öffnet für größere Umstellungen die Admin-Seite an der richtigen Stelle.

Diese Beschreibung ist als **Vorlage für alle Projekte** gedacht. Bekommt ein anderes Projekt später auch einen Anschluss, bietet es dieselben Funktionen mit denselben Namen. Das Dashboard kann dann jedes Projekt gleich behandeln.

## Einbinden

```html
<script src="https://kalyptooo.github.io/lumen/lumen-connect.js"></script>
<script>
  const lumen = await LumenConnect.connect();
</script>
```

Das Skript lädt Firebase und die Projekt-Einstellungen selbst. Es nutzt eine eigene Firebase-App namens `lumen-connect` und stört deshalb kein Firebase, das das Dashboard selbst verwendet. Ein lauffähiges Beispiel steht in `dashboard-beispiel.html`.

`connect.json` beschreibt das Projekt kurz (Name, Symbol, Adressen, Skript). Ein Dashboard kann daraus eine Liste seiner Projekte bauen, ohne die Skripte zu laden.

## Anmelden

Mit dem Lumen-Admin-Konto, einmal pro Gerät. Die Anmeldung bleibt gespeichert.

| Aufruf | Ergebnis |
| --- | --- |
| `lumen.state()` | `{ signedIn, email, verified, fresh, admin }` |
| `lumen.onChange(cb)` | ruft `cb(state)` bei jeder Anmelde-Änderung |
| `lumen.signIn(email, passwort)` | meldet an und gibt den Zustand zurück |
| `lumen.reauth(passwort)` | bestätigt das Passwort neu (Regel: Admin-Rechte nur 12 Stunden nach der letzten Passwort-Eingabe) |
| `lumen.signOut()` | meldet ab |

## Daten lesen

`lumen.summary()` liefert alles Wichtige in einem Stück. Das Ergebnis wird 5 Minuten zwischengespeichert. Mit `summary({ force: true })` wird neu geladen.

```js
{
  project:  { id, name, icon, app, admin, contract },
  at, today,
  people:   { unlocked, registered, activeToday, active7, reminders, idle: [Namen], waiting: [E-Mails] },
  learning: { learned, answered, pct, bestStreak: { name, days }, perDay: [{ date, active }] /* 14 Tage */,
              areas: [{ key, name, read, pct }] },
  reports:  { open, items: [{ factId, note, reportedAt }] },
  content:  { factsUntil, daysLeft, lastRun: { at, added, notes }, newsDate },
  notice:   { text, at },
  usage:    { verdict: { level, title, text, note }, items: [{ key, name, used, limit, pct, level, text, forecast }],
              free: [{ name, text }], at, stale, lacksAccess },
  attention: [{ level: 'info' | 'warn' | 'alert', text, link }]
}
```

`attention` ist die Liste für den Blick „Muss ich etwas tun?“. Jeder Eintrag hat schon einen Link an die passende Stelle der Admin-Seite. Aufgenommen werden:

- offene Fehlermeldungen
- Fakten reichen nur noch weniger als 7 Tage
- die Wochenaufgabe lief über 8 Tage nicht
- Personen sind freigeschaltet, aber noch nicht registriert
- Personen waren länger als eine Woche nicht da
- eine kostenlose Grenze wird knapp, oder die stündliche Messung der Auslastung fehlt

`lumen.people()` gibt die Personenliste zurück, die zuletzt Aktiven zuerst: `uid, name, email, lastSeen, streak, learned, answered, pct, due, reports, admin, unlocked, link`.

**Kosten:** Ein frischer Abruf liest etwa 3 Einträge pro Person aus der Datenbank, bei 20 Personen also rund 60. Der kostenlose Tarif erlaubt 50.000 pro Tag. Lädt das Dashboard höchstens alle 5 Minuten neu, bleibt es weit darunter.

## Alltägliche Aktionen

`lumen.actions` listet sie mit Beschriftung, damit ein Dashboard Knöpfe dafür bauen kann. Ausführen mit `lumen.run(id, eingabe)`. Die Antwort ist ein kurzer deutscher Satz, Fehler kommen als `Error` mit deutscher `message`.

| id | Eingabe | Wirkung |
| --- | --- | --- |
| `notice` | Text (max. 400 Zeichen) | Mitteilung an alle oben auf „Heute“ |
| `clearNotice` | – | Mitteilung entfernen |
| `invite` | eine oder mehrere E-Mails | Personen freischalten |
| `lock` | E-Mail | Zugang sperren (nicht für Admins) |

Bewusst **nicht** im Anschluss sind die folgenden Aktionen. Sie gibt es nur auf der Admin-Seite:

- Lernstände löschen
- Admin-Rechte vergeben oder entziehen
- Fakten bearbeiten
- Themen-Gewichte und Tagesplan ändern

## Meldungen (Postfach)

Alles Wichtige, was in Lumen passiert, landet als Meldung im Postfach. Das Dashboard holt es ab und zeigt es zusammen mit den Meldungen anderer Projekte. Jede Meldung sieht gleich aus:

```js
{ id, key, at, level: 'info' | 'warn' | 'alert', project: 'lumen', source, title, text, link, seen }
```

| Aufruf | Ergebnis |
| --- | --- |
| `lumen.events({ since, unseen, limit })` | Meldungen, neueste zuerst. `since` = ISO-Zeit, `unseen: true` = nur ungelesene |
| `lumen.markSeen(at)` | alles bis `at` (Standard: jetzt) als gelesen markieren |
| `lumen.send({ level, title, text, link, source })` | selbst eine Meldung ablegen, zum Beispiel vom Dashboard aus |
| `lumen.usage()` | nur die Auslastung, mit einem einzigen Datenbank-Abruf |
| `summary().inbox` | `{ unseen, latest }` für eine Zahl am Symbol |

Wer Meldungen schickt:

| Quelle | Wann |
| --- | --- |
| stündlicher Wächter (`tools/usage-report.mjs`) | neue Anmeldung, neue Fehlermeldung zu einem Fakt, Fehler in der App auf einem Handy, kostenlose Grenze wird knapp, Freigabe für die Zahlen fehlt, Fakten reichen keine 7 Tage mehr, Wochenaufgabe über 8 Tage still |
| Erinnerungs-Ablauf | wenn er abbricht |
| jedes Skript oder jeder Ablauf | `node tools/notify.mjs <info/warn/alert> "Titel" "Text" [Link] [Quelle]` |
| das Dashboard | `lumen.send(...)` |

Gespeichert wird in `config/access` (nur für Admins lesbar), höchstens 60 Meldungen. Dieselbe Meldung (gleicher `key`) kommt nur einmal. Der Wächter liest dafür stündlich die Personenliste mit. Das sind etwa 1.000 Lesungen am Tag, rund 2 % des freien Rahmens.

## Zur Admin-Seite springen

`lumen.link(bereich, id)` oder `LumenConnect.link(...)` gibt die Adresse zurück. Die Admin-Seite öffnet sich dort, fragt aber zur Sicherheit selbst nach der Anmeldung.

| Bereich | Öffnet |
| --- | --- |
| `overview` | Übersicht |
| `people` | Personen; mit `id` = uid gleich die Karte dieser Person |
| `settings` | Für alle (Mitteilung, Themen, Tagesplan) |
| `facts` | Fakten bearbeiten |
| `reports` | Fehlermeldungen |
| `weekly` | Wochenaufgabe |
| `usage` | Auslastung der kostenlosen Grenzen |

## Sicherheit

- Die Datenbank-Regeln (`firestore.rules`) gelten unverändert. Der Anschluss kann nichts, was die Admin-Seite nicht auch darf.
- Die Admin-Seite selbst lässt sich nicht in andere Seiten einbetten. Darum gibt es den Anschluss statt eines eingebetteten Fensters.
- Liegt das Dashboard auf einer anderen Adresse als `kalyptooo.github.io`, muss die Adresse eventuell in Firebase unter Authentication → Einstellungen → Autorisierte Domains eingetragen werden.

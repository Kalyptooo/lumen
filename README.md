# Lumen

Fünf Fakten am Tag, ein kurzes Quiz zum Vortag und Auffrischung nach dem Leitner-Prinzip. Für eine kleine Gruppe, mit Anmeldung per E-Mail und Passwort.

- **Lernseite:** `index.html` (auf dem iPhone über „Teilen“ → „Zum Home-Bildschirm“ wie eine App)
- **Admin-Seite:** `admin.html` (Übersicht, Personen, Monetarisierung, Themen für alle, Fehlermeldungen)

## Aufbau

| Teil | Wo | Wer schreibt |
| --- | --- | --- |
| Fakten, „Aktuell“, Themenlisten, Protokolle | `data/` in diesem Archiv, als JSON | die Wochenaufgabe (Cloud-Routine), sonntags |
| Lernstand, Einstellungen, Zusammenfassung je Person | Firestore (`data/users/<uid>/…`, `digest/<uid>`, `members/<uid>`) | die Lernseite |
| Admins | Firestore `config/access` | die Admin-Seite |
| Bezahlen: Gratis-Zeit, Freischaltung, Betrag, Zahltag, Sperre | Firestore `billing/<uid>`, Einstellungen in `config/billing` | die Lernseite legt beim ersten Öffnen die Gratis-Zeit an, sonst nur die Admin-Seite |
| Themen-Gewichte, Wunsch, weitergegebene Fehlermeldungen | Firestore `config/public` (öffentlich lesbar) | die Admin-Seite; die Wochenaufgabe liest sie |

Anmeldung: Firebase Authentication (E-Mail und Passwort, Adresse muss bestätigt sein). Wer was lesen und schreiben darf, steht in `firestore.rules`. Firebase-Projekt `lumen-f76be` im kostenlosen Spark-Tarif, Datenbank in Frankfurt.

## Dateien

| Datei | Zweck |
| --- | --- |
| `index.html` | Lernseite. Block `lumen-logic` = reine Logik (getestet), Block `lumen-app` = Oberfläche |
| `admin.html` | Admin-Seite |
| `lumen-connect.js`, `connect.json`, `CONNECT.md` | Anschluss für ein eigenes Dashboard: Zahlen lesen, alltägliche Admin-Aktionen, Sprung-Links in die Admin-Seite (`admin.html#people/<uid>` usw.). Beispiel: `dashboard-beispiel.html` |
| `tools/notify.mjs`, `tools/fb-rest.mjs` | Meldungen ans Dashboard-Postfach (`node tools/notify.mjs warn "Titel" "Text"`), REST-Helfer für das Dienstkonto |
| `lumen-usage.js`, `tools/usage-report.mjs` | Tab „Auslastung“: misst stündlich (mit den Erinnerungen) die kostenlosen Grenzen und bewertet sie; zugleich der Wächter, der Meldungen ans Postfach schickt. Für die Lesezahlen braucht das Dienstkonto die Rolle „Monitoring-Betrachter“ |
| `lumen-billing.js`, `tools/billing-reminders.mjs` | Bezahlen: jede Person registriert sich selbst, hat ein paar Tage gratis, dann schaltet der Admin nach einer Überweisung frei (monatlich im Voraus) oder sperrt. Zahltag-Erinnerungen an die Person und die Admins kommen einmal am Tag ab 9 Uhr mit dem Erinnerungs-Ablauf. Die eigentliche Sperre steht in `firestore.rules` |
| `lumen-cloud.js` | Anmeldung, Datenbank und Laden der Inhalte aus `data/`, von beiden Seiten genutzt |
| `firebase-config.js` | Kennung des Firebase-Projekts (öffentlich, kein Geheimnis) |
| `firestore.rules` | Zugriffsregeln, in der Firebase-Konsole veröffentlicht |
| `weekly-task-prompt.md` | Auftrag der Wochenaufgabe |
| `tools/lumen-weekly.mjs` | Hilfsskript der Wochenaufgabe (planen, prüfen, übernehmen) |
| `tools/build-manifest.mjs` | baut `data/manifest.json` neu |
| `tools/make-icons.mjs` | zeichnet die App-Symbole |
| `tests/` | Tests (`node tests/logic.test.mjs`, `node tests/weekly.test.mjs`, `node tests/usage.test.mjs`) und lokale Vorschau mit nachgebildetem Firebase (`node tests/dev-server.mjs`) |

## Ändern

1. Seite oder Skript bearbeiten, beide Testdateien ausführen.
2. Vorschau: `node tests/dev-server.mjs`, dann `http://localhost:4174/?scene=ready` (Szenen `signin`, `verify`, `denied`, `ready`) oder `http://localhost:4174/admin.html?admin=1`.
3. Committen und nach `main` pushen. GitHub Pages veröffentlicht nach ein bis zwei Minuten.
4. Geänderte `firestore.rules` zusätzlich in der Firebase-Konsole unter Firestore → Regeln einfügen und veröffentlichen.

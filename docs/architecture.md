# Architektur

MailPilot liest verbundene Postfächer auf dem Server, erkennt mit KI Aufgaben und synchronisiert sie mit den Apple-Geräten. Apple Mail bleibt das Mailprogramm.

## Bausteine

| Baustein | Pfad | Aufgabe |
|---|---|---|
| Verträge | `packages/contracts` | Zod-Schemas für API, Sync, Jobs und KI-Ausgabe; Zeithilfen |
| Datenbank | `packages/database` | Drizzle-Schema, Migrationen, Änderungsprotokoll, Verschlüsselung der Zugangsdaten |
| Mail-Anbindung | `packages/mail-connectors` | Gmail API, Microsoft Graph, IMAP/TLS hinter einem `MailConnector`-Interface; MIME/HTML-Aufbereitung |
| KI | `packages/ai` | Austauschbarer Adapter (Anthropic), Prompt, Schutzregeln, Kosten |
| API | `services/api` | Fastify-REST-API mit OpenAPI, Anmeldung, Sync, Konten |
| Worker | `services/worker` | Graphile Worker: Abruf, Analyse, Markierung, Rückfragen, Zeitplan, Mitteilungen |
| Apple-Clients | `apps/apple` | SwiftUI-Apps für iPhone und Mac, Widgets, App Intents, Share Extension |

API und Worker laufen unabhängig von den Geräten. PostgreSQL ist die einzige Infrastruktur; die Jobqueue liegt in derselben Datenbank.

## Datenfluss

1. **Abruf** (`scan_account`): Der Worker holt neue und geänderte Mails über Anbieter-Cursor (Gmail History, Graph Delta, IMAP UIDVALIDITY/UID bzw. CONDSTORE). Mails werden nie als gelesen markiert, nie verschoben, kopiert oder gelöscht.
2. **Speichern**: Jede Mail hat eine unveränderliche interne ID und eine anbieterbezogene Identität (`identity_key`, eindeutig je Konto). Die RFC-Message-ID ist ein zusätzliches Signal, ein Inhalts-Fingerprint der kontrollierte Fallback. Verschieben ändert nur `message_locations`; Löschen setzt `deleted_at` und lässt Aufgaben bestehen.
3. **Analyse** (`analyze_message`): nur neue oder inhaltlich geänderte Mails, je Benutzer nacheinander (Budgetprüfung). Eigene gesendete Mails dienen nur als Gesprächskontext.
4. **Anwenden**: Aufgaben anlegen oder ergänzen, Rückfragen anlegen, Markierungsauftrag in die Outbox schreiben – alles in einer Transaktion.
5. **Markieren** (`apply_marker`): nach dem Commit, mit begrenzten Wiederholungen. Ein Fehler betrifft nur den Markerstatus.
6. **Synchronisieren**: Jede sichtbare Änderung erzeugt einen Eintrag im `change_log`. Geräte holen Deltas per Cursor und senden Offline-Änderungen über eine Outbox mit Idempotency Keys (siehe [sync.md](sync.md)).

## Eindeutigkeit und Idempotenz

- Mail ↔ Aufgabe ist n:m (`task_sources`). Eine automatisch erkannte Aufgabe ist über `(message_id, action_key)` mit Rolle `origin` eindeutig; zwei Analysen derselben Mail erzeugen nie zwei Aufgaben.
- Geräte legen keine Aufgaben aus Mails an; das macht nur der Worker. Mehrere Geräte können dieselbe Mail daher nicht doppelt umwandeln.
- Jobs tragen Job-Keys (`scan:<konto>`, `analyze:<mail>`, `marker:<operation>`), Analysejobs laufen je Benutzer in einer eigenen Queue.
- Alle Schreibtransaktionen eines Benutzers nehmen zuerst eine Advisory-Sperre je Benutzer. Dadurch entspricht die Reihenfolge der `change_log`-Sequenz der Commit-Reihenfolge, und ein Cursor überspringt nie eine spät committete Änderung.

## Aufgabenmodell

Pro Aufgabe getrennt: KI-Vorschläge (`ai_*`), manuelle Werte (`manual_*`), Status, Priorität, Frist, Snooze, „Warte auf Antwort“, Version mit Feldversionen, Herkunft und Evidenz (`task_sources.evidence_quotes`, `task_events`). Angezeigt wird immer der manuelle Wert vor dem KI-Wert; KI-Aktualisierungen schreiben nur `ai_*`.

## Sicherheit

- Anmeldung mit Sign in with Apple; der Identity Token wird serverseitig gegen Apples JWKS geprüft (Signatur, Aussteller, Audience, Ablauf, Nonce). Sitzungstoken sind zufällig und werden nur als SHA-256-Hash gespeichert.
- Der Entwicklungslogin existiert nur mit `DEV_LOGIN_ENABLED=true` außerhalb von production.
- Mailzugänge werden getrennt autorisiert (OAuth mit PKCE bzw. IMAP-App-Passwort) und mit AES-256-GCM verschlüsselt gespeichert. Der Apple-Account allein gewährt keinen Mailzugriff.
- KI-Schlüssel liegen nur auf dem Server. Mailinhalte gehen ausschließlich als Daten an das Modell; der Prompt behandelt Anweisungen in Mails als Inhalt.
- Die sichere Mailansicht liefert bereinigtes HTML ohne Skripte und ohne Remote-Inhalte; Anhänge nur als Metadaten.

## Betrieb

- Täglicher Scan zur eingestellten Ortszeit (Standard 07:00 Europe/Paris), optional häufiger, jederzeit manuell.
- Der Zeitplan prüft alle fünf Minuten; der Tagesscan wird per bedingtem Update genau einmal beansprucht, auch bei mehreren Worker-Prozessen.
- Ein Sicherheitsnetz stellt verlorene Analyse- und Markierungsjobs erneut ein.
- APNs ist optional; ohne Push bleibt alles nutzbar.

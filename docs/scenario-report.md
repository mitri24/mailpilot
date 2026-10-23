# Prüfbericht Abschlussszenario (Auftrag Abschnitt 26)

Stand: 23.10.2026. Alle Fälle mit Testdaten; echte Anbieterkonten und ein echtes KI-Modell waren nicht verfügbar, weil die Zugangsdaten fehlen. Die Modellausgaben sind Fixtures; die Schutzregeln, die jede Modellausgabe prüfen, sind unabhängig davon getestet.

## Testläufe

| Paket | Tests | Ergebnis |
|---|---|---|
| `packages/ai` | 25 | bestanden |
| `packages/mail-connectors` (davon 8 gegen GreenMail über IMAP/TLS) | 102 | bestanden |
| `services/api` | 40 | bestanden |
| `services/worker` (inkl. Ende-zu-Ende API + Worker) | 21 | bestanden |
| `apps/apple/MailPilotKit` (Swift-Package, macOS) | 75 | bestanden |

Befehle: `pnpm test` mit laufender Postgres und GreenMail aus `infra/docker-compose.yml`; für das Swift-Package `swift test` wie in [apple.md](apple.md). App-, Widget- und Share-Targets sind nicht in Xcode gebaut, weil auf dem Prüfrechner kein Xcode installiert war; ihr macOS-Code wurde in einem Hilfspaket fehlerfrei übersetzt.

**Live-Durchlauf am 23.10.2026:** API und Worker als echte Prozesse, GreenMail als IMAP-Server mit TLS. Entwicklungslogin, Konto über die API verbunden (Fähigkeiten erkannt, Posteingang gewählt), Scan ausgelöst, Aufgabe „Studienbescheinigung schicken“ mit Frist und Quellmail in „Heute“. Die Mail hatte danach keine Flags, wurde also nicht als gelesen markiert. KI: Fixture.

## Fälle

| Fall | Erwartet | Beobachtet | Prüfung | Daten | Einschränkungen |
|---|---|---|---|---|---|
| Zwei Mailkonten | Getrennt verbunden, Aufgaben gemeinsam in „Heute“, Fehler je Konto | Zwei IMAP-Konten über die API, je ein Scanlauf, Aufgaben beider Konten in „Heute“ | automatisiert: `services/worker/test/scenario.test.ts` | Testpostfächer | Gmail und Graph nur gegen nachgebildete API-Antworten nach offizieller Doku |
| Deutsche und französische Mail | Deutscher Titel mit Verb, deutsche Zusammenfassung, Frist mit wörtlichem Beleg, Sprache erkannt | „Studienbescheinigung schicken“ (fr) und „Nebenkostenabrechnung prüfen“ (de) mit belegten Fristen, Sprache `fr` gespeichert | automatisiert: `scenario.test.ts`, `pipeline.test.ts`; Live-Durchlauf | Testmails, Fixture-KI | Qualität echter Modellausgaben nicht geprüft |
| Unklare Rundmail | Rückfrage statt Aufgabe; „Diesmal nicht“ ohne Regel; „Ja, dauerhaft“ erzeugt sichtbare Zuordnung; spätere Mails ohne erneute Frage | Genau so; Aufgabe erst nach „Ja“, Zuordnung in `/v1/rules` änder- und löschbar | automatisiert: `pipeline.test.ts`, `scenario.test.ts`, `services/api/test/clarifications.test.ts` | Testmails | – |
| Mail mit Anhang | Anhang nur als Metadaten, Hinweis „Anhang lesen nötig“, kein erfundener Inhalt, Checkliste nur bei echten Schritten | Metadaten in der KI-Eingabe, Kennzeichnung gesetzt, Checkliste mit zwei Schritten aus der Mail | automatisiert: `pipeline.test.ts`; MIME-Zerlegung in `packages/mail-connectors/test/content.test.ts` | Testmail mit PDF-Anhang | Anhänge werden bewusst nie gelesen |
| Antwort mit geänderter Frist | Dieselbe Aufgabe aktualisiert, Verlauf mit altem und neuem Wert samt Quellmail, neueste Änderung sichtbar, manuelle Priorität bleibt | Frist 24.10. → 27.10. im Verlauf mit Quelle, „Die Frist wurde von Freitag auf Montag verschoben.“, manuelle Priorität unverändert, keine zweite Aufgabe | automatisiert: `pipeline.test.ts` | Testmails im selben Thread | – |
| Verschobene Originalmail | Keine neue Aufgabe, keine erneute Analyse, Quelle bleibt, Ort aktualisiert | Alter Ort `present=false`, neuer Ort aktiv, eine Mail, eine Aufgabe, keine zweite Analyse; IMAP MOVE gegen GreenMail liefert Ortswechsel mit gleicher Identität | automatisiert: `pipeline.test.ts`, `packages/mail-connectors/test/imap.greenmail.test.ts` | Testpostfach | – |
| Offline-Statusänderung | Veraltetes Gerät setzt eine inzwischen erledigte Aufgabe nicht still zurück; Konflikt sichtbar; andere Änderungen bleiben | Server meldet `conflict` mit `status`, Aufgabe bleibt erledigt, Notiz aus derselben Outbox übernommen, Änderungsfeed liefert den Stand an beide Geräte; der Client übernimmt den Serverstand und zeigt den Konflikt | automatisiert: `scenario.test.ts`, `services/api/test/sync.test.ts`, Swift-Test „Statuskonflikt: veraltetes Offlinegerät …“ | Testdaten, Mock-Server im Client-Test | Nicht auf Geräten geprüft |
| Zwei gleichzeitig bearbeitete Notizen | Keine Fassung geht verloren | Veraltete Bearbeitung wird eigene Notiz mit Verweis auf das Original, Verlaufseintrag „beide Fassungen behalten“ | automatisiert: `services/api/test/tasks.test.ts` | Testdaten | – |
| Widget-Aktion | „Erledigt“ oder „Starten“ im Widget, sofort im Widget sichtbar, Synchronisierung übernimmt | Die Aktion schreibt in die gemeinsame Outbox, der Snapshot ist sofort aktuell und als „noch nicht synchronisiert“ gekennzeichnet | automatisiert: Swift-Test „Widget-Aktion „Erledigt“ …“ | Testdaten | Echtes Widget mit WidgetKit auf Mac und iPhone nicht geprüft (kein Xcode) |
| Fehlgeschlagener Mailabruf | Fehler je Konto mit konkreter Handlung, Hinweis in „Heute“, nichts verloren oder erfunden | `auth_failed` → Status „erneut verbinden“ mit Handlung „Konto erneut verbinden“, Lauf mit Grund als fehlgeschlagen, keine Aufgabe; gegen GreenMail: falsches Passwort → `auth_failed`, selbstsigniertes Zertifikat → `tls`, geschlossener Port → `network` | automatisiert: `pipeline.test.ts`, `services/api/test/accounts.test.ts`, `imap.greenmail.test.ts` | Testpostfach | – |

## Weitere geprüfte Regeln

- Unveränderte Mails werden nicht erneut analysiert; ein zweiter Scan erzeugt weder Analyse noch Duplikat.
- Newsletter und eigene gesendete Mails erzeugen keine Aufgaben; eigene Antworten erscheinen nur im Verlauf.
- Verworfene Aufgaben entstehen nicht neu; erledigte werden nicht wieder geöffnet, neue Verpflichtungen im Thread werden Folgeaufgaben.
- Budget erreicht: Mails werden weiter erfasst, Analyse pausiert sichtbar und läuft nach Budgeterhöhung weiter.
- Begrenzte Wiederholungen; eine fehlgeschlagene Analyse endet als „fehlgeschlagen“, nie als „keine Aufgabe“.
- Zwei Geräte, die dieselbe Mail als Aufgabe aufnehmen, erhalten dieselbe Aufgabe.
- Täglicher Scan genau einmal zur Ortszeit, auch über die Sommerzeitumstellung; Mitteilungen nur nach Zustimmung, gebündelt, dedupliziert, mit Ruhezeiten.
- Sign in with Apple: Signatur, Audience und Nonce werden geprüft; Sitzungstokens nur als Hash gespeichert.

## Nicht geprüft

- Echte Gmail-, Microsoft-365- und iCloud-Konten sowie die Sichtbarkeit von Markierungen in Apple Mail.
- Ein echtes Anthropic-Modell.
- Apple-Apps und Widgets auf Geräten.
- APNs-Zustellung.

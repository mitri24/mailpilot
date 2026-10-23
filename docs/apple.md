# Apple-Clients (iOS und macOS)

Native SwiftUI-Apps für iPhone und Mac mit Widgets, App Intents und Share Extension. Mindestversionen: iOS 17, macOS 14. Das Backend (`services/api`) ist die Quelle; die Apps halten einen lokalen Cache mit Offline-Outbox.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `apps/apple/MailPilotKit/` | Swift-Package (Swift 6). Produkt `MailPilotKit`: Modelle nach `docs/openapi.json`, API-Client, GRDB-Cache, Outbox, Sync-Engine, Heute-Ranking, Widget-Snapshot, Deep Links, Keychain. Produkt `MailPilotUI`: gemeinsame SwiftUI-Ansichten. Tests in `Tests/MailPilotKitTests` (swift-testing). |
| `apps/apple/iOS/` | App-Einstieg iPhone: Tabs, Board mit Statusbuttons, APNs-Delegate. `Support/` enthält Info.plist und Entitlements. |
| `apps/apple/macOS/` | App-Einstieg Mac: Seitenleiste, Board mit Drag-and-drop, Tastaturkürzel (Menüs „Gehe zu“, „Aufgabe“). |
| `apps/apple/Widgets/` | WidgetKit-Extension (gleicher Code für iOS und macOS): klein, mittel, groß. |
| `apps/apple/Shared/Intents/` | App Intents „Erledigt“ und „Starten“; in App und Widget-Extension kompiliert. |
| `apps/apple/Share/` | Share Extension (Text, Links). |
| `apps/apple/Config/` | xcconfig mit Platzhaltern (Bundle-ID, Team-ID, App Group, Server-URL). |
| `apps/apple/project.yml` | XcodeGen-Spezifikation: 6 Targets, 2 Schemata, lokales Package. |
| `apps/apple/Tools/` | Werkzeuge für Test-Fixtures aus dem TypeScript-Vertrag (siehe „Tests“). |

## Xcode-Projekt erzeugen

Voraussetzungen: Xcode 16.3 oder neuer (GRDB 7.11.1 verlangt `swift-tools-version: 6.1`), XcodeGen.

```sh
brew install xcodegen
cd apps/apple
cp Config/Local.xcconfig.example Config/Local.xcconfig   # eigene Werte eintragen (nicht eingecheckt)
xcodegen generate                          # erzeugt MailPilot.xcodeproj
open MailPilot.xcodeproj                   # Schema MailPilot-iOS oder MailPilot-macOS
```

Platzhalter in `Config/Base.xcconfig` (in `Config/Local.xcconfig` überschreiben):

| Build-Setting | Platzhalter | Bedeutung |
|---|---|---|
| `MAILPILOT_BUNDLE_ID` | `com.example.mailpilot` | Bundle-ID der App; Erweiterungen: `.widgets`, `.share` |
| `MAILPILOT_TEAM_ID` | leer | Apple-Developer-Team-ID |
| `MAILPILOT_APP_GROUP` | `group.$(MAILPILOT_BUNDLE_ID)` | gemeinsamer Container für Cache und Outbox |
| `MAILPILOT_KEYCHAIN_GROUP` | `$(MAILPILOT_BUNDLE_ID).shared` | Keychain Access Group (Xcode setzt `$(AppIdentifierPrefix)` davor) |
| `MAILPILOT_API_BASE_URL` | Debug `http://localhost:8787`, Release `https://mailpilot.example.invalid` | Server-URL; in Entwicklungs-Builds zusätzlich in der App änderbar |

Die Werte landen über die Info.plist (`MailPilotAPIBaseURL`, `MailPilotAppGroup`, `MailPilotKeychainAccessGroup`) im Code (`AppConfiguration.fromBundle`). Im Simulator erreicht `localhost` den lokalen Server; auf einem Gerät die LAN-Adresse oder einen HTTPS-Server eintragen.

## Auf dem eigenen Mac starten (auch mit kostenloser Apple-ID)

Debug-Builds verwenden `MailPilot-Dev.entitlements` ohne Sign in with Apple. So kann auch ein kostenloses Apple-ID-Team signieren; angemeldet wird mit dem Entwicklungslogin. Release-Builds behalten Sign in with Apple und brauchen die Mitgliedschaft im Apple Developer Program.

1. Server starten (siehe README) mit `DEV_LOGIN_ENABLED=true`.
2. In `Config/Local.xcconfig` eine eigene Bundle-ID setzen und für den Mac die App Group mit Team-Präfix verwenden:
   ```
   MAILPILOT_BUNDLE_ID = de.deinname.mailpilot
   MAILPILOT_APP_GROUP = $(TeamIdentifierPrefix)$(MAILPILOT_BUNDLE_ID)
   ```
3. `xcodegen generate`, dann `open MailPilot.xcodeproj`.
4. In Xcode unter Einstellungen → Accounts die Apple-ID hinzufügen.
5. Schema `MailPilot-macOS` und Ziel „Mein Mac“ wählen, bei den drei Mac-Targets unter „Signing & Capabilities“ das Team auswählen, mit ⌘R starten.
6. In der App den Entwicklungslogin nutzen und ein Postfach verbinden. Widget: Rechtsklick auf den Schreibtisch → „Widgets bearbeiten …“ → MailPilot.

Nicht geprüft: Die App-Targets wurden bisher nicht in Xcode gebaut. Ob ein kostenloses Team alle übrigen Capabilities (App Group, Keychain Sharing) signieren kann, zeigt erst der erste Build.

## Apple-Developer-Einstellungen

- **App IDs**: App, `….widgets`, `….share`, jeweils für iOS und macOS (dieselbe Bundle-ID für beide Plattformen ist vorgesehen).
- **Sign in with Apple**: Capability an der App-ID. Serverseitig `APPLE_AUDIENCES` auf die Bundle-ID setzen (`services/api/src/config.ts`). Die App sendet den Rohwert der Nonce an `POST /v1/auth/apple`, Apple bekommt den SHA-256-Hex-Wert.
- **App Groups**: `group.<bundle-id>` registrieren und allen drei App-IDs zuweisen. Auf macOS ist laut Apple-Dokumentation alternativ `<Team-ID>.<name>` ohne Registrierung möglich (`MAILPILOT_APP_GROUP = $(TeamIdentifierPrefix)$(MAILPILOT_BUNDLE_ID)`). Ohne gültige App Group fällt die App auf einen eigenen Ordner zurück; Widget und Share Extension sehen dann keine Daten.
- **Keychain Sharing**: Gruppe `<bundle-id>.shared` für App, Widget und Share Extension. Auf macOS nutzt `KeychainTokenStore` den Data-Protection-Keychain (`kSecUseDataProtectionKeychain`); das setzt eine signierte App mit Bereitstellungsprofil voraus.
- **macOS**: App Sandbox mit `com.apple.security.network.client` (alle drei Targets), Hardened Runtime.
- **Push (optional)**: APNs-Capability aktivieren und `CODE_SIGN_ENTITLEMENTS` auf `iOS/Support/MailPilot-Push.entitlements` bzw. `macOS/Support/MailPilot-Push.entitlements` umstellen. Die App fragt erst beim Einschalten einer Benachrichtigung in den Einstellungen nach der Erlaubnis und sendet das Token an `POST /v1/devices/push`. Ohne Push bleibt alles nutzbar.
- **OAuth (Gmail, Microsoft)**: Die App startet `POST /v1/accounts/oauth/{provider}/start` und öffnet die URL in `WebAuthenticationSession` (SwiftUI-Hülle von `ASWebAuthenticationSession`) mit Callback-Schema `mailpilot`. Der Server leitet auf `mailpilot://accounts/connected?accountId=…` bzw. `…/error?code=…` weiter. Beim Anbieter ist nur die Server-Redirect-URI `…/v1/oauth/callback/{provider}` einzutragen.
- **Entwicklungslogin**: nur in Debug-Builds sichtbar und nur nutzbar, wenn der Server `DEV_LOGIN_ENABLED=true` außerhalb von Produktion hat.

## Funktionsweise

**Cache und Outbox.** GRDB-Datenbank im App-Group-Container (`Library/Application Support/MailPilot/cache.sqlite`, WAL über `DatabasePool`, Öffnen koordiniert per `NSFileCoordinator`). Tabellen: `tasks` (komplettes Task-JSON plus Abfragespalten und zwischengespeichertes Detail), `notes`, `checklist`, `clarifications`, `accounts`, `rules`, `settings`, `outbox`, `sync_state`, `widget_snapshot`, zusätzlich `sync_notices` für sichtbare Konflikte und Ablehnungen. Angezeigt wird immer Serverstand plus Outbox (optimistisch). Jede lokale Änderung ist eine Mutation exakt nach `Mutation` im Vertrag, mit eigenem Idempotency-Key; der gespeicherte Body wird nach dem ersten Sendeversuch nie verändert, Wiederholungen senden dieselben Bytes. Noch nie gesendete Änderungen derselben Entität werden zusammengefasst (z. B. zwei Statuswechsel, Notiz anlegen und gleich ändern, „Nicht relevant“ und sofort „Rückgängig“).

**Synchronisierung** (`SyncEngine`): Senden in Reihenfolge an `POST /v1/sync/mutations`, höchstens 100 je Stapel und je Stapel höchstens eine Änderung pro Entität. `applied`/`duplicate` werden als bestätigt markiert und bleiben bis zum nächsten vollständigen Abruf sichtbar; `conflict` entfernt die Änderung, der Serverwert gilt, der Hinweis „Auf einem anderen Gerät geändert“ erscheint an der Aufgabe (bei Notizen legt der Server die konkurrierende Fassung als eigene Notiz an); `rejected` entfernt die Änderung und zeigt den Fehler. Hat der Abruf inzwischen einen neueren Serverstand gebracht, vergleicht der Client vor dem Senden die Ausgangswerte: unverändert → auf die neue Version setzen, vom anderen Gerät geändert → dieses Feld nicht senden und Konflikt zeigen. Danach `GET /v1/sync/changes?cursor=…` bis `hasMore=false`; ohne Cursor Vollabzug, Tombstones löschen lokal, `resetRequired` verwirft den Cursor und ersetzt den Serverstand (die Outbox bleibt). Netzwerkfehler: Wiederholung mit exponentiellem Backoff (2 s bis 5 min). Auslöser: Öffnen, Vordergrund, jede Änderung (entprellt), Pull-to-refresh bzw. ⌘R.

**Heute** wird lokal mit derselben Logik wie `services/api/src/domain/today.ts` berechnet (auch offline und mit noch nicht synchronisierten Änderungen). `pendingAnalysisCount` stammt aus dem letzten `GET /v1/today`; ohne diesen Wert wird die Summe der Konten angezeigt. „Keine Aufgaben“ erscheint nie, solange Mails ungeprüft sind. „Auf morgen verschieben“ setzt nur `plannedFor` und weist sachlich darauf hin, wenn morgen nach der Frist liegt.

**Widgets** lesen nur `widget_snapshot` (keine Mailimporte, keine KI-Aufrufe). Klein: wichtigste Aufgabe und Anzahl offener Aufgaben; mittel: bis zu drei Aufgaben; groß: weitere Aufgaben und Hinweis auf Rückfragen. „Erledigt“ und „Starten“ sind `Button(intent:)`: Der Intent schreibt in die gemeinsame Outbox, aktualisiert den Snapshot sofort (Kennzeichnung „noch nicht synchronisiert“) und versucht höchstens 6 Sekunden zu synchronisieren. Angezeigt werden Alter des Stands (ab 6 Stunden „veraltet“), Offline, ausstehende und nicht übernommene Änderungen sowie „nicht angemeldet“. Wann das System Widgets neu lädt, ist nicht garantiert.

**Share Extension**: Text und Links werden zu einer eigenen Aufgabe mit dem Inhalt als Notiz (über die gemeinsame Outbox). Apple Mail liefert über das Teilen-Menü nicht zuverlässig die ganze Mail; der Ersatzweg ist in der App „Mails“ → Mail suchen → „Als Aufgabe aufnehmen“ (`POST /v1/messages/{id}/task`).

**Originalmail**: eigene Ansicht über `GET /v1/messages/{id}` mit Text als garantierter Darstellung; formatiertes HTML optional in `WKWebView` ohne JavaScript, mit Content-Security-Policy ohne Netzwerkzugriffe und ohne Navigation. Webmail-Link, falls vorhanden; „In Apple Mail öffnen“ nur als Versuch mit Hinweis des Servers und kopierbaren Suchangaben.

**Deep Links**: `mailpilot://today`, `mailpilot://board`, `mailpilot://tasks/<id>`, `mailpilot://clarifications`, `mailpilot://messages`, `mailpilot://settings`, `mailpilot://accounts`, `mailpilot://accounts/<id>`, `mailpilot://accounts/connected?accountId=…`, `mailpilot://accounts/error?code=…`.

## Tests

```sh
cd apps/apple/MailPilotKit
FW=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
LIB=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
swift test -Xswiftc -F -Xswiftc $FW -Xlinker -F -Xlinker $FW -Xlinker -rpath -Xlinker $FW -Xlinker -rpath -Xlinker $LIB
```

Mit Xcode genügt `swift test` bzw. ⌘U im geöffneten Package. Die Tests nutzen swift-testing statt XCTest (siehe `docs/adr/0002-swift-testing-statt-xctest.md`).

Fixtures entstehen aus dem TypeScript-Code und werden dort geprüft (im Repository-Wurzelverzeichnis):

```sh
node_modules/.bin/tsx apps/apple/Tools/today-parity.ts       # erwartete Ränge/Reihenfolge aus services/api/src/domain/today.ts
node_modules/.bin/tsx apps/apple/Tools/contract-fixtures.ts  # Beispielantworten und erwartete Request-Bodies, mit den Zod-Schemas geprüft
```

Abgedeckt: Heute-Ranking (Parität mit dem Server in drei Szenarien inkl. Europe/Paris, Sommerzeitwechsel, Jahreswechsel und `suggested`-Fristen), Outbox (Persistenz über Neustart, Reihenfolge, Zusammenfassen, Stapel ≤ 100, gleiche Keys und Bytes bei Wiederholung, Entfernen nach Bestätigung), Sync-Engine mit Mock-Transport (Vollabzug, Delta, Tombstones, `hasMore`-Paging, `resetRequired`, Statuskonflikt, konkurrierende Notizen, Ablehnung, Prüfung vor dem Senden, Scheduler-Wiederholung), JSON-Decoding der Vertragsbeispiele (`YYYY-MM-DD` und ISO 8601 mit `Z` und Offset), Request-Encoding gegen die Eingabeschemas, Widget-Snapshot (veraltet, offline, ausstehend, abgemeldet, Widget-Aktion), „Auf morgen verschieben“, Board-Filter, Sortierschlüssel, Deep Links, API-Client über Mock-`URLProtocol` (`Authorization: Bearer`, `Idempotency-Key`, Query-Kodierung, Fehler).

## Prüfstand

Auf dem Entwicklungsrechner (Command Line Tools, Swift 6.3.2, macOS-SDK 26.5, kein Xcode) geprüft:

- `swift build` und `swift test` des Packages: 75 Tests in 11 Suites bestanden.
- Fixture-Werkzeuge: 40 Beispiele erfüllen die Zod-Schemas; Gegenprobe mit absichtlich fehlerhaften Beispielen wird abgelehnt. Paritätsdaten aus dem Servercode (3 Szenarien, 39 Aufgaben).
- Gezielte Fehlereinbauten (Ranking, Konfliktprüfung, Null-Kodierung, Bearer-Header) werden von den Tests erkannt.
- macOS-Varianten von App, Widget-Extension und Share Extension: Typprüfung und Linken in einem temporären SwiftPM-Package (nicht eingecheckt), Swift 6, Zielversion macOS 14, ohne Warnungen.
- Offscreen-Rendering einiger Ansichten auf macOS mit Vertragsbeispielen (Heute hell/dunkel, Detail, Rückfragen, Einstellungen, Anmeldung).
- `project.yml`: YAML gültig, alle referenzierten Dateien, Targets und Packages vorhanden; `plutil -lint` für alle Info.plist- und Entitlements-Dateien.

Nur in Xcode bzw. auf Geräten prüfbar:

- `xcodegen generate`, Build der iOS-Targets (iOS-SDK fehlt), Signieren, Asset-Katalog-Kompilierung, App-Intents-Metadaten.
- iOS-spezifischer Code (`#if os(iOS)`: Tabs, iPhone-Board, `UIApplication`, `UIPasteboard`, Share-Controller, WKWebView-Hülle) ist nicht kompiliert.
- Sign in with Apple, Keychain mit Access Group und Data-Protection-Keychain (braucht Entitlements), App-Group-Container zwischen App und Erweiterungen, Widget-Darstellung und interaktive Widget-Buttons, Share Extension in Safari/Mail, APNs-Registrierung, `WebAuthenticationSession` mit echtem OAuth-Anbieter, Bedienung mit VoiceOver, Dynamic Type und Tastatur.
- Zusammenspiel mit einem laufenden Server (die Tests verwenden Mock-Transport und Mock-`URLProtocol`).

## Grenzen

- Quellen und Verlauf einer Aufgabe kommen nicht über den Änderungsfeed; sie werden beim Öffnen geladen und lokal zwischengespeichert, offline gilt der letzte geladene Stand.
- Kontoverwaltung, Mailsuche, Korrekturen, Zusammenführen und Einstellungen brauchen eine Verbindung; Aufgaben, Status, Notizen, Checkliste und Rückfragen funktionieren offline.
- Ein IMAP-Passwort lässt sich über die API nicht ändern; bei „erneute Anmeldung nötig“ hilft nur Entfernen und neu Verbinden.
- App-Icons sind Platzhalter ohne Bild.

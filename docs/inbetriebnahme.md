# Inbetriebnahme

Was noch fehlt, damit MailPilot mit echten Konten läuft. Geheimnisse nur in `.env` auf dem Server oder in einer Secret-Verwaltung eintragen – nie in Code, Doku oder Tickets.

## 1. Server

- [ ] Server oder VM mit Docker Compose (oder Node 22 LTS + PostgreSQL 17), dauerhaft laufend, unabhängig von den Apple-Geräten.
- [ ] Öffentliche HTTPS-Adresse für die API (Reverse Proxy mit TLS) → `PUBLIC_BASE_URL`.
- [ ] `CREDENTIALS_ENCRYPTION_KEY` erzeugen (`openssl rand -base64 32`) und sicher aufbewahren. Geht er verloren, müssen alle Postfächer neu verbunden werden.
- [ ] `NODE_ENV=production`, `DEV_LOGIN_ENABLED` leer lassen.
- [ ] Regelmäßige Backups der Datenbank.
- [ ] Zeitzone und Scanzeit prüfen (Standard 07:00 Europe/Paris, in der App änderbar).

## 2. Apple Developer

- [ ] Mitgliedschaft im Apple Developer Program, Team-ID.
- [ ] App-IDs für iOS-App, macOS-App, Widget- und Share-Extensions. Bundle-ID, Team-ID und Server-Adresse in `apps/apple/Config/Local.xcconfig` eintragen (Vorlage `Local.xcconfig.example`).
- [ ] Capability „Sign in with Apple“ für die App-IDs → Bundle-IDs in `APPLE_AUDIENCES` (kommagetrennt).
- [ ] App Group (`group.<bundle-id>`) für App, Widgets und Share Extension.
- [ ] Keychain Sharing (gemeinsame Access Group) für das Sitzungstoken.
- [ ] Optional Push: APNs-Schlüssel (.p8) anlegen → `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY_FILE` (Pfad auf dem Server), `APNS_TOPIC` (Bundle-ID der App).
- [ ] Xcode 16.3 oder neuer und XcodeGen installieren, Projekt erzeugen, auf iPhone und Mac installieren, Widgets hinzufügen (siehe [apple.md](apple.md)).

## 3. Gmail (je Google-Konto)

- [ ] Google-Cloud-Projekt, Gmail API aktivieren.
- [ ] OAuth-Zustimmungsbildschirm; Scopes `openid`, `email` und `https://www.googleapis.com/auth/gmail.readonly` (nur lesen) oder `https://www.googleapis.com/auth/gmail.modify` (für Labels als Markierung).
- [ ] OAuth-Client vom Typ „Webanwendung“, Weiterleitungs-URI `<PUBLIC_BASE_URL>/v1/oauth/callback/gmail` → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- [ ] Solange die App im Testmodus ist, die eigenen Adressen als Testnutzer eintragen. `gmail.readonly` und `gmail.modify` sind eingeschränkte Scopes; für eine Veröffentlichung verlangt Google eine Prüfung.

## 4. Microsoft 365 / Outlook (je Konto oder Organisation)

- [ ] App-Registrierung in Microsoft Entra, Plattform „Web“, Weiterleitungs-URI `<PUBLIC_BASE_URL>/v1/oauth/callback/microsoft`.
- [ ] Delegierte Berechtigungen `Mail.Read` (oder `Mail.ReadWrite` für Kategorien/Flaggen als Markierung), `offline_access`, `openid`, `email`.
- [ ] Clientgeheimnis → `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`; `MICROSOFT_TENANT` (`common`, `organizations` oder Tenant-ID).
- [ ] Hochschul- und Firmenkonten: Die Organisation kann die Zustimmung durch die IT verlangen. Das kann MailPilot nicht umgehen.

## 5. iCloud und andere IMAP-Konten

- [ ] iCloud: app-spezifisches Passwort unter appleid.apple.com erzeugen; Server `imap.mail.me.com`, Port 993.
- [ ] Andere Anbieter: IMAP-Server laut Einrichtungsvorschlag in der App prüfen. Ob IMAP erlaubt ist, entscheidet der Anbieter bzw. die Organisation; die App prüft die Verbindung und zeigt erkannte Fähigkeiten.
- [ ] Ordner auswählen (Standard: Posteingang und Gesendet; Spam und Papierkorb ausgeschlossen), Importzeitraum (Standard 14 Tage), eigene Aliasse eintragen.

## 6. KI

- [ ] Anthropic-API-Schlüssel → `ANTHROPIC_API_KEY` (nur auf dem Server).
- [ ] `AI_PROVIDER=anthropic`, Modell in `ANTHROPIC_MODEL` (z. B. `claude-opus-5-5`), optional `ANTHROPIC_EFFORT`.
- [ ] Für Modelle ohne hinterlegte Preise `AI_PRICE_INPUT_PER_MTOK` und `AI_PRICE_OUTPUT_PER_MTOK` setzen.
- [ ] Monatsbudget in der App einstellen (Standard 5 USD).

## 7. Erster Durchlauf

- [ ] In der App mit Apple anmelden, erstes Postfach verbinden, Umfang und Markierung wählen, ersten Import starten.
- [ ] Erste echte Aufgabe prüfen: Titel, Frist mit Beleg, Begründung, Originalmail.
- [ ] Optional Mitteilungen und Ruhezeiten einstellen.

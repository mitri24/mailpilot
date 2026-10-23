# Mail-Connectoren (`@mailpilot/mail-connectors`)

Das Paket ist die einzige Stelle, die mit Mailservern spricht. Worker und API nutzen nur die Schnittstelle `MailConnector` aus `src/types.ts`:

```ts
const connector = createConnector(account, { fetch, imapTls, logger });
const capabilities = await connector.verify();
const result = await connector.fetchChanges(request); // so lange, bis result.complete === true
await connector.applyMarker(markerRequest, "set");
await connector.close();
```

Grundsätze, die für alle Anbieter gelten:

- **Nie als gelesen markieren.** IMAP liest nur in `EXAMINE` (schreibgeschützt) mit `BODY.PEEK[]`; Gmail und Graph lesen nur per GET.
- **Nie verschieben, kopieren oder löschen** – einzige Ausnahme ist die ausdrücklich gewählte Strategie `imap_copy_folder` (legt eine Kopie an und löscht beim Aufheben nur diese Kopie).
- **Nur verschlüsselt.** IMAP: implizites TLS oder erzwungenes STARTTLS, Zertifikatsprüfung immer aktiv. HTTP-Anfragen gehen nur an `gmail.googleapis.com` bzw. `graph.microsoft.com`; Links aus Cursorn oder Antworten mit anderem Ursprung werden nicht verfolgt (das Token gelangt nie an fremde Hosts).
- **Anhänge nur als Metadaten** (Name, Typ, Größe, inline). Inhalte werden beim Parsen gezählt und verworfen; bei Graph wird `contentBytes` gar nicht abgerufen.
- **Logs ohne Inhalte**: nur IDs, Zähler und Fehlercodes – keine Adressen, Betreffs, Texte oder Zugangsdaten. Der Logger ist pino-kompatibel (`warn(obj, msg)`).

## Anbieter

### IMAP (imapflow)

| Thema | Umsetzung |
|---|---|
| Verbindung | `secure: true` = implizites TLS (Port 993). `secure: false` = STARTTLS ist Pflicht (`doSTARTTLS: true`): bietet der Server kein STARTTLS an, scheitert die Verbindung mit `tls` – es wird nie im Klartext angemeldet. TLS-Optionen kommen ausschließlich über den injizierten Parameter `imapTls` (z. B. eigene CA oder Testzertifikat). |
| Lesen | `getMailboxLock(…, { readOnly: true })` → `EXAMINE`; Abruf über imapflow `source` → `BODY.PEEK[]<0.N>` (N = `maxMessageBytes + 1`, größere Nachrichten werden gar nicht vollständig geladen). |
| `verify()` | Öffnet INBOX einmal mit `SELECT`, weil manche Server in `EXAMINE` leere `PERMANENTFLAGS` melden. `SELECT` setzt kein `\Seen`. |
| Ordner | `LIST` mit `STATUS (UIDVALIDITY)`; Rollen aus SPECIAL-USE (RFC 6154: `\Sent`, `\Trash`, `\Junk`, `\Archive`, `\Drafts`) bzw. der Namenserkennung von imapflow, `INBOX` → `inbox`. Ordner mit `\Noselect` werden ausgelassen. |
| Identität | `identityKey = "rfc:<Message-ID>"`, ohne Message-ID `"fp:<headersFingerprint>"`. Dieselbe Nachricht in zwei Ordnern hat dieselbe identityKey und zwei Orte. |
| Inkrementell | CONDSTORE/QRESYNC, wenn der Server sie per `ENABLE` aktiviert, sonst UID-basiert (Details unter „Cursor“). |
| Robustheit | Bricht die Verbindung ab, antwortet imapflow auf `SEARCH` mit `undefined`; das gilt als `network`-Fehler, nie als leeres Ergebnis – es wird kein Cursor geschrieben. Geteilte oder eingeschobene `FETCH`-Antworten derselben UID werden zusammengeführt; fehlt der Nachrichtentext auch nach einem Einzelabruf, scheitert der Abruf (`server`) statt eine leere Nachricht zu speichern. Fehlt `UIDNEXT`, gilt die höchste vorhandene UID. |

### Gmail (REST-API v1, `fetch` injizierbar)

- **Erstimport:** `users.messages.list` je gewähltem Label (`labelIds=<Label>`, `q=after:<Unix-Sekunden>`). Google interpretiert Datumsangaben in `q` als Mitternacht PST und empfiehlt für genaue Zeitpunkte Sekunden – daher Sekunden. Danach `users.messages.get?format=raw` → `processMime`.
- **Deltas:** `users.history.list?startHistoryId=…&historyTypes=messageAdded|messageDeleted|labelAdded|labelRemoved`. Die History-Einträge enthalten laut Doku meist nur `id`/`threadId`; betroffene Nachrichten werden deshalb neu geholt und nach ihren aktuellen Labels beurteilt.
  - `messagesDeleted` → `deleted`; entferntes gewähltes Label (z. B. Archivieren = `INBOX` weg) → `location_removed`; Nachricht im Papierkorb/Spam (nicht gewählt) → `location_removed` für ihre gewählten Labels.
  - Gelesen-/Stern-Änderungen (`UNREAD`/`STARRED`) von Nachrichten in gewählten Ordnern → `upsert` mit aktuellen Flags.
  - Ein Durchlauf übernimmt höchstens 10 000 Nachrichten-IDs aus der History und setzt danach am letzten verarbeiteten History-Eintrag fort (`complete: false`), damit der Cursor nie die eigene Größengrenze überschreitet.
- **Cursor-Verlust:** Laut Google liefert ein zu alter oder ungültiger `startHistoryId` HTTP 404; dann folgt ein Neuimport im Fenster und `cursorResets` (`history_expired`) für alle gewählten Ordner. History-Einträge sind „typischerweise mindestens eine Woche“ verfügbar, manchmal deutlich kürzer.
- **Spam/Papierkorb:** `includeSpamTrash=true` wird nur gesendet, wenn `SPAM` bzw. `TRASH` ausdrücklich als Ordner gewählt ist.
- **Felder:** `identityKey = "gmail:<id>"` (laut Google unveränderlich), `providerThreadId = threadId`, `labels = labelIds`, `receivedAt = internalDate`. `location.flags` wird aus Labels abgeleitet (`UNREAD` fehlt → `\Seen`, `STARRED` → `\Flagged`).
- **Weblink:** `https://mail.google.com/mail/u/0/#search/rfc822msgid:<Message-ID ohne Klammern, URL-kodiert>`. Grenze: `u/0` ist das erste im Browser angemeldete Google-Konto; ohne Message-ID gibt es keinen Link.
- `listFolders()` liefert Labels ohne `UNREAD`, `CHAT` und die `CATEGORY_*`-Tabs.
- Abgewählte Labels werden nicht weiter importiert; ein in Gmail gelöschtes Label (Antwort 400 „Invalid label“ bzw. 404) wird einmal als `folder_missing` gemeldet, statt jeden Abruf scheitern zu lassen.

### Microsoft Graph (v1.0, `fetch` injizierbar)

- Jede Anfrage trägt `Prefer: IdType="ImmutableId"` (der Header gilt laut Doku nur für die Anfrage, in der er steht). Immutable IDs bleiben beim Verschieben innerhalb des Postfachs gleich; sie ändern sich beim Verschieben ins Archivpostfach oder bei Export/Re-Import.
- **Delta je Ordner:** `/me/mailFolders/{id}/messages/delta?$select=…&$filter=receivedDateTime ge <since>` mit `Prefer: odata.maxpagesize=<Budget, max. 50>`. `@odata.nextLink` wird verfolgt, `@odata.deltaLink` ist der Cursor der nächsten Runde.
- **`@removed`:** Graph meldet laut Doku `"reason": "deleted"`, wenn eine Nachricht gelöscht **oder aus dem Ordner verschoben** wurde. Der Connector schlägt die Immutable ID nach: 404 → `deleted`, sonst `location_removed` (die Nachricht taucht im Delta des Zielordners als `upsert` mit gleicher identityKey auf, wenn er gewählt ist).
- Delta-Einträge ohne `body` (z. B. reine Gelesen-Änderung) werden per `GET /me/messages/{id}` nachgeladen.
- **Inhalt aus JSON:** `body` (HTML wird bereinigt), `from`/`sender`, `toRecipients`, `ccRecipients`, `internetMessageId`, `conversationId`, `webLink` (Outlook im Web), `categories`, `flag`, `isRead`. Anhänge über `/attachments?$select=name,contentType,size,isInline` – auch wenn `hasAttachments` falsch ist, aber `cid:`-Verweise im HTML stehen (laut Doku zählt `hasAttachments` Inline-Anhänge nicht).
- **Token abgelaufen:** `410 Gone` (Synchronisations-Reset) oder ein 40x mit Code wie `syncStateNotFound` → neue Runde im Importfenster, `cursorResets` (`delta_token_expired`).
- **Ordner gelöscht (404):** einmal `folder_missing`, danach ein Platzhalter-Cursor (`missing: true`), damit weitere Abrufe nichts wiederholen.

## OAuth und Scopes

`buildAuthorizationUrl(config, { access })` erzeugt URL, `state` und PKCE-Verifier (S256, 43 Zeichen); `state` und `codeVerifier` muss die API bis zum Callback speichern. `exchangeCode` löst den Code ein, `refreshAccessToken` erneuert, `createOAuthTokenSource` liefert eine `OAuthTokenSource` mit Cache, Single-Flight-Refresh und `onTokens`-Callback zum Speichern.

| Anbieter | Variante | Scopes | Hinweise |
|---|---|---|---|
| Google | nur lesen (`read`) | `openid email https://www.googleapis.com/auth/gmail.readonly` | `gmail.readonly` ist „restricted“. |
| Google | mit Markierung (`mark`) | `openid email https://www.googleapis.com/auth/gmail.modify` | `gmail.modify` deckt Lesen ab, erlaubt aber kein endgültiges Löschen; „restricted“. `messages.modify` verlangt `gmail.modify` (oder `mail.google.com`). |
| Microsoft | nur lesen | `openid email offline_access https://graph.microsoft.com/Mail.Read` | `offline_access` ist für ein Refresh-Token nötig. |
| Microsoft | mit Markierung | `openid email offline_access https://graph.microsoft.com/Mail.ReadWrite` | `PATCH /me/messages/{id}` verlangt `Mail.ReadWrite`. |

- **Google:** Endpunkt `https://accounts.google.com/o/oauth2/v2/auth`, Token `https://oauth2.googleapis.com/token`, `access_type=offline` (laut Google Voraussetzung für ein Refresh-Token, das „nur bei der ersten Autorisierung“ geliefert wird) und `prompt=consent`, damit die Zustimmung bei einer erneuten Verbindung wieder abgefragt wird. Beim Refresh liefert Google kein neues Refresh-Token – das bisherige bleibt gültig. Restricted Scopes erfordern eine OAuth-Verifizierung; wer Daten aus solchen Scopes auf Servern speichert, braucht laut Google zusätzlich ein Security Assessment.
- **Microsoft:** `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize|token` (`tenant` Standard `common`), `response_mode=query`, `prompt=select_account`. Die Antwort auf einen Refresh enthält ein **neues Refresh-Token, das das alte ersetzt** (`refreshTokenRotated: true`) – unbedingt speichern. `Mail.Read`/`Mail.ReadWrite` brauchen laut Berechtigungsreferenz keine Administratorzustimmung („Admin consent required: No“). Ob eine Organisation die Zustimmung durch Benutzer per Richtlinie einschränkt, ist mandantenabhängig (nicht geprüft).
- Das Konto (`account.email`) wird aus dem ID-Token gelesen, ohne Signaturprüfung – zulässig, weil das Token direkt vom Token-Endpunkt per TLS kommt. Graph-Access-Tokens werden nicht dekodiert (Microsoft rät davon ab).
- Fehler: `invalid_grant`, `interaction_required`, `consent_required` → `needs_reauth`; `invalid_client`, `unauthorized_client`, `invalid_scope` … → `config`. Scheitert nur das Speichern rotierter Tokens im `onTokens`-Callback, meldet die Token-Quelle `server` (nicht „Konto erneut verbinden“); das neue Token bleibt im Speicher gültig.
- `refreshAccessToken` ergänzt bei Microsoft `offline_access`, falls die gespeicherten Scopes (aus einer Token-Antwort) es nicht enthalten – sonst gäbe es kein neues Refresh-Token.

## Cursor-Strategien

Cursor sind für Aufrufer undurchsichtig: versioniertes JSON, mit zod geprüft. Schlüssel: `imap:<Ordnerpfad>`, `gmail:*`, `microsoft:<Ordner-ID>`. Ein unlesbarer Cursor führt zu `cursorResets` (`cursor_invalid`) und einem Neuimport. Nicht verarbeitete Cursor werden unverändert zurückgegeben.

- **Budget:** `maxMessages` begrenzt die Nachrichtenabrufe pro Aufruf. Ist es erschöpft, liefert der Connector `complete: false` und einen Cursor, an dem der nächste Aufruf weitermacht.
- **Garantie:** mindestens einmal – Wiederholungen (gleiche `upsert` erneut) sind möglich, Verluste nicht. Wirft ein Aufruf, ist kein Cursor fortgeschrieben; der nächste Aufruf wiederholt die Arbeit. `contentHash` verhindert erneute Analysen.
- **`cursorResets[].reason`:** `uidvalidity_changed`, `history_expired`, `delta_token_expired`, `cursor_invalid`, `folder_missing`.

**IMAP** (je Ordner): `uv` (UIDVALIDITY), `last` (höchste bearbeitete UID), `known` (UIDs importierter Nachrichten als Sequence-Set), `since` (laufender Import), `ms`/`msTarget`/`fcAfter` (CONDSTORE).

1. **Expunge:** mit QRESYNC `UID FETCH <bekannte> (UID FLAGS) (CHANGEDSINCE ms VANISHED)` – die `VANISHED (EARLIER)`-Antworten liefern gelöschte UIDs; sonst `UID SEARCH UID <bekannte>` und Abgleich. Ergebnis: `location_removed` mit Ordner, UIDVALIDITY und UID (`identityKey: null`, der Worker ordnet über den Ort zu).
2. **Flag-Änderungen (nur CONDSTORE):** `CHANGEDSINCE ms` → `upsert` mit aktuellen Flags. Ein Scan, der das Budget sprengt, wird über `msTarget`/`fcAfter` fortgesetzt; `ms` rückt erst nach vollständigem Scan vor. Ohne CONDSTORE werden Flag-Änderungen bekannter Nachrichten nicht gemeldet.
3. **Neue Nachrichten:** `UID SEARCH UID <last+1>:*` (während des Erstimports zusätzlich `SINCE <since>`; IMAP vergleicht nur das Datum, nicht die Uhrzeit).
- **UIDVALIDITY-Wechsel:** `cursorResets` (`uidvalidity_changed`), `location_removed` für alle bekannten UIDs mit der **alten** UIDVALIDITY, danach Neuimport im Fenster `since`. Ohne Cursor, aber mit abweichender `FetchFolder.uidValidity` wird ebenfalls `uidvalidity_changed` gemeldet.
- **Verschieben (MOVE):** alter Ordner → `location_removed`, neuer Ordner (falls gewählt) → `upsert` mit derselben identityKey (über die Message-ID).
- **Ordner verschwunden:** einmal `folder_missing` und `location_removed` für die bekannten UIDs; der Cursor wird zum Platzhalter (UIDVALIDITY 0), sodass weitere Abrufe nichts wiederholen. Wird der Ordner neu angelegt, folgt ein Neuimport im Fenster (`uidvalidity_changed`).
- Jeder `fetchChanges`-Aufruf baut die Verbindung neu auf, wenn noch ein Ordner ausgewählt ist – sonst würde imapflow den Ordner ohne neues `EXAMINE` weiterverwenden (veraltete UIDVALIDITY/UIDNEXT). `CLOSE` wird nie gesendet, weil es im Schreibmodus `\Deleted`-Nachrichten endgültig löscht.

**Gmail** (ein Cursor `gmail:*`): `h` (historyId, vor dem Import gelesen, damit Änderungen während des Imports im nächsten Delta erscheinen), `sel` (Labels, die ein Import abgedeckt hat – neu gewählte Labels bekommen einen eigenen Import), `q` (noch abzuholende IDs eines unterbrochenen Deltas), `init` (laufender Import: verbleibende Labels, Seite, Warteschlange).

**Graph** (je Ordner): `url` (`@odata.deltaLink` bzw. `@odata.nextLink` einer laufenden Runde), `paging`. Grenze: Wegen des `$filter` auf `receivedDateTime` meldet die Delta-Abfrage Nachrichten nicht, die älter als das Importfenster sind und später in einen gewählten Ordner verschoben werden; mit `$filter` liefert eine Delta-Runde laut Doku höchstens 5000 Nachrichten.

## Markierungsstrategien und ihre Grenzen in Apple Mail

Apple Mail konnte in dieser Umgebung nicht getestet werden; alle Aussagen zur Darstellung in Apple Mail sind **nicht geprüft**, sofern nicht anders vermerkt.

| Strategie | Umsetzung | Aufheben (`clear`) | In Apple Mail | Grenzen |
|---|---|---|---|---|
| `imap_keyword` | `UID STORE +FLAGS (<Schlagwort>)` | Schlagwort entfernen | nicht sichtbar – Apple Mail hat keine Anzeige für eigene IMAP-Schlagwörter | Nur wenn `PERMANENTFLAGS` `\*` enthält (oder das Schlagwort bereits führt), sonst `unsupported`. Schlagwort muss ein IMAP-Atom sein. |
| `imap_flagged` | `\Flagged` setzen | `\Flagged` entfernen | als Markierung/Fähnchen (nicht geprüft) | `\Flagged` ist nicht von einer eigenen Markierung des Nutzers unterscheidbar. War die Nachricht schon markiert, meldet `set` `detail: "already_present"` – der Aufrufer darf dann später **nicht** `clear` aufrufen. Markiert der Nutzer nach MailPilot selbst, entfernt `clear` auch seine Markierung. |
| `imap_copy_folder` | `UID COPY` in den Zielordner (wird bei Bedarf angelegt), Kopie erhält das Schlüsselwort `$MailPilotCopy` (über COPYUID/UIDPLUS) | sucht und löscht in **einer** `SELECT`-Sitzung nur Nachrichten mit gleicher Message-ID **und** `$MailPilotCopy` per `UID EXPUNGE` | Kopie erscheint als eigene Nachricht im Zielordner (nicht geprüft) | Aufheben nur mit UIDPLUS (sonst `unsupported`). Ohne COPYUID wird die Kopie nicht gekennzeichnet und kann nicht automatisch entfernt werden. Bei Gmail über IMAP (`X-GM-EXT-1`) nicht angeboten: Kopieren vergibt dort nur ein Label, die „Kopie“ wäre das Original. `$MailPilotCopy` ist als eigenes Schlagwort gesperrt. Den Zielordner nicht zur Abrufauswahl hinzufügen (sonst zweiter Ort derselben identityKey). |
| `gmail_label` | eigenes Label (Standard „MailPilot“, nur `type: user`) anlegen falls nötig (`labelListVisibility: labelShow`, `messageListVisibility: show`), dann `messages.modify` | `removeLabelIds` | Laut Google behandelt Gmail Labels bei IMAP-Zugriff als Ordner – in Apple Mail also vermutlich als zusätzlicher Ordner (nicht geprüft) | Braucht die Variante „mit Markierung“ (`gmail.modify`). Namen von Systemlabels (Inbox, Spam, Trash, Unread, Starred, Important, Sent, Draft, Chat, `CATEGORY_*`) werden abgelehnt – sie würden archivieren, löschen oder als gelesen markieren. |
| `graph_category` | `PATCH categories` (ganze Liste, Kategorie ergänzt) | Kategorie aus der Liste entfernen | Kategorien zeigt Apple Mail nach unserem Kenntnisstand nicht an (nicht geprüft) | Die Kategorie wird ohne Eintrag in der Masterkategorienliste gesetzt (dafür wäre `MailboxSettings.ReadWrite` nötig); Outlook zeigt sie dann ggf. ohne Farbe. |
| `graph_flag` | `PATCH flag.flagStatus = flagged` | `notFlagged` | hängt von der Kontoart ab (nicht geprüft) | wie `\Flagged`: nicht von einer eigenen Kennzeichnung unterscheidbar; `already_present` beachten. |

`applyMarker` liefert `applied`, `unsupported` oder `failed` (z. B. Nachricht nicht mehr vorhanden, UIDVALIDITY veraltet). `detail` ist `null`, `"already_present"`, `"not_present"` oder ein deutscher Hinweis. Kontoweite Probleme (Anmeldung, fehlende Rechte, Drosselung, Netzwerk) werden als `ConnectorError` geworfen.

## Inhalte

`processMime(raw, { maxMessageBytes, sizeBytes?, truncated? })` liefert alle inhaltlichen Felder von `NormalizedMessage`:

- mailparser im Streaming-Modus; Anhänge werden nur gezählt (`size` = dekodierte Bytes), `inline` bei `Content-Disposition: inline` oder `Content-ID` in `multipart/related`.
- **HTML-Bereinigung** (sanitize-html, Allow-List): keine Skripte, Event-Handler, Formulare, Frames, SVG, `<style>`-Blöcke; Inline-Styles nur aus einer Eigenschaftsliste und ohne `url()`, `expression()`, Escapes; Links nur `http`, `https`, `mailto` mit `rel="noopener noreferrer"` (andere verlieren das `href`); **Remote-Bilder** werden durch `<span class="mp-remote-image">[Bild: …]</span>` ersetzt, **Tracking-Pixel** (≤ 2 px, versteckt oder typische Tracker-URL) ganz entfernt; `cid:`-Bilder werden zu `mp-inline-image`-Platzhaltern (Anhänge werden nicht gespeichert), kleine `data:image/png|jpeg|gif|webp` bleiben. `remoteContentBlocked` zählt alle entfernten Fremdverweise (Bilder inkl. Pixel, `srcset`, `background`, CSS-`url()`, eingebettete Quellen).
- **Text:** `text/plain`, sonst html-to-text über das bereinigte HTML (ohne Bilder/Platzhalter). Unsichtbare Zeichen und Zeilenenden werden normalisiert.
- `snippet` (≤ 200 Zeichen, ohne Zitat/Signatur), `contentHash` = sha256 über den Text mit normalisiertem Leerraum, `headersFingerprint` = sha256 über From (klein), Date (ISO), Subject, Message-ID. Unlesbare `Date`-Header ergeben `sentAt: null` (mailparser würde „jetzt“ einsetzen und den Fingerprint instabil machen).
- `maxMessageBytes`: Darüber wird nicht geparst, `truncated: true`; `sizeBytes` bleibt die volle Größe.
- Laufzeit: Bereinigung und Reduktion bleiben auch bei bösartigen Eingaben linear (ungeschlossene `<style>`-Tags, lange Leerzeichenfolgen, viele zuschreibungsähnliche Zeilen); dafür gibt es Regressionstests.

`reduceForAnalysis(bodyText, { maxChars, maxQuotedChars? })` → `{ text, quotedContext, signatureRemoved, truncated }`:

- Zitatgrenzen: „Am … schrieb …:“, „On … wrote:“, „Le … a écrit :“, „<Name> schrieb am …:“ – jeweils nur mit Datum oder Uhrzeit, höchstens 400 Zeichen, über bis zu drei Zeilen umbrochen (nie nach einem Satzende); „<Name> wrote:“ nur, wenn `>`-Zeilen folgen; Outlook-Kopfblöcke „Von:/From:/De:“ mit Datums-, Empfänger- **und** Betreffzeile; Trennzeilen („-----Original Message-----“, „Ursprüngliche Nachricht“, „Forwarded message“, `____`); `>`-Blöcke am Ende.
- Inline- und Unten-Antworten: Schreibt der Absender unter dem `>`-Zitat weiter (auch nur „Ok“), bleiben sein Text und die beantworteten Zitatzeilen (Ebene 1) samt Zuschreibung erhalten; nur reine Gruß-, Namens- oder Kontaktzeilen unter dem Zitat gelten als Signatur. Wiederholte Zitate (Ebene ≥ 2) fallen weg.
- Signaturen: `-- ` (RFC 3676) trennt immer, ein bloßes `--` nur vor einem Signaturblock; mobile Signaturen („Von meinem iPhone gesendet“, „Sent from my …“, „Envoyé de mon …“); Grußblöcke („Viele Grüße“, „Mit freundlichen Grüßen“, „Best regards“, „Cordialement“, „Danke“ …) nur, wenn danach ausschließlich Namens-, Titel-, Adress- oder Kontaktzeilen folgen (keine Sätze, Fragen, Aufforderungen). „PS:“/„Nachtrag:“ bleiben erhalten. Besteht die Antwort nur aus einem Gruß („Danke!“), bleibt sie stehen.
- `quotedContext` ist der Anfang der zuletzt zitierten Nachricht (mit Zuschreibung bzw. Kopfblock, ohne deren Signatur und ältere Zitate), Standardbudget ein Drittel von `maxChars` (200–1500 Zeichen). Bei reinen Weiterleitungen wird die weitergeleitete Nachricht zum `text`.

## Fehlercodes (`ConnectorError`)

| Code | Auslöser (Beispiele) | `userAction` |
|---|---|---|
| `auth_failed` | IMAP: Anmeldung abgelehnt (`AUTHENTICATIONFAILED`, `EXPIRED`) | Zugangsdaten oder App-Passwort prüfen |
| `needs_reauth` | HTTP 401 auch nach einem Refresh-Versuch; Token-Endpunkt `invalid_grant`, `interaction_required` | Konto erneut verbinden |
| `permission_denied` | HTTP 403 (fehlende Berechtigung, `ErrorAccessDenied`); Gmail `domainPolicy`; IMAP `NOPERM` | Berechtigungen prüfen und Konto erneut verbinden · bei `domainPolicy`: Administrator um Freigabe für MailPilot bitten |
| `rate_limited` | HTTP 429; Gmail 403 `rateLimitExceeded`/`userRateLimitExceeded`/`dailyLimitExceeded`; 503 mit Retry-After; IMAP `ETHROTTLE`/`LIMIT` | Kurz warten – MailPilot versucht es automatisch erneut (`retryAfterSeconds` aus `Retry-After`, Sekunden oder HTTP-Datum) |
| `network` | DNS, Verbindungsabbau, Zeitüberschreitung, Port geschlossen | Internetverbindung und Serveradresse prüfen |
| `tls` | Zertifikat ungültig, TLS-Handshake fehlgeschlagen, kein STARTTLS angeboten | Sichere Verbindung fehlgeschlagen – Server, Port und Verschlüsselung prüfen |
| `server` | HTTP 5xx, 409/410/412/423, unerwartete Antworten, abgelehnte IMAP-Befehle | Später erneut versuchen – der Mailserver meldet einen Fehler |
| `config` | übrige 4xx, OAuth `invalid_client`/`invalid_scope`, ungültige Adresse | Kontoeinstellungen prüfen · OAuth-Einrichtung von MailPilot prüfen · E-Mail-Adresse prüfen |
| `not_supported` | (reserviert) | Diese Funktion wird von diesem Konto nicht unterstützt |

Der Connector wiederholt nur einmal nach einem 401 (mit erneuertem Token). Wiederholungen nach 429/5xx plant der Worker anhand von `retryAfterSeconds`.

## Einrichtungsvorschlag (`suggestAccountSetup`)

Ein SRV-Ziel außerhalb der Mail-Domain wird nur mit `confidence: "low"` und dem Hinweis vorgeschlagen, es vor dem Verbinden zu bestätigen (RFC 6186 §6: gefälschte DNS-Antworten könnten das Passwort an einen fremden Server lenken).

Reihenfolge: bekannte Domains (iCloud: `icloud.com`, `me.com`, `mac.com` → `imap.mail.me.com:993`, App-Passwort, Benutzername laut Apple meist der Teil vor dem @; Gmail/Googlemail → Google-OAuth; Outlook/Hotmail/Live → Microsoft-OAuth) → MX-Eintrag (Google Workspace, Microsoft 365, iCloud+ mit eigener Domain) → DNS-SRV nach RFC 6186 (`_imaps._tcp`, dann `_imap._tcp` mit STARTTLS) → Mozilla-ISPDB `https://autoconfig.thunderbird.net/v1.1/<Domain>` (sendet nur die Domain; SSL wird STARTTLS vorgezogen, Klartext ignoriert) → Vermutung `imap.<Domain>` mit `confidence: "low"`. Jede DNS-/HTTP-Abfrage hat ein Timeout (Standard 3 s). Das Ergebnis behauptet nie, dass IMAP oder OAuth erlaubt ist: Für Organisations- und unbekannte Domains steht in `notes`, dass Hochschul- und Firmenkonten IMAP oft abschalten oder eine Freigabe der IT verlangen.

## Fixture für Worker-Tests

```ts
const mailbox = new FixtureMailbox({ provider: "imap", capabilities: { supportedMarkers: ["none", "imap_flagged"] } });
const message = await mailbox.addMessage("INBOX", rawEml, { flags: [], receivedAt: new Date() });
const connector = new FixtureConnector(mailbox);
mailbox.moveMessage(message.identityKey, "Sent");   // location_removed + upsert
mailbox.deleteMessage(message.identityKey);         // deleted
mailbox.setFailure(fixtureError("needs_reauth"), { once: true, operations: ["fetchChanges"] });
mailbox.changeUidValidity("INBOX");                 // cursorResets beim nächsten Abruf
mailbox.removeFolder("Sent");                       // folder_missing (einmal), Platzhalter-Cursor
connector.markerOperations;                         // aufgezeichnete applyMarker-Aufrufe
```

Echte Cursor-Semantik: Erstimport nur im Fenster (`receivedAt`), danach nur Änderungen seit dem Cursor, `maxMessages` und `complete` wie bei den echten Connectoren. Marker ändern Flags/Labels und erscheinen beim nächsten Abruf als `upsert` (gleicher `contentHash`).

## Tests

```bash
docker compose -f infra/docker-compose.yml --profile test up -d greenmail
pnpm --filter @mailpilot/mail-connectors run typecheck
pnpm --filter @mailpilot/mail-connectors run test
```

- **Gegen GreenMail (echt):** Erstimport im Fenster, inkrementell nur Neues, Aufteilung nach `maxMessages`, `\Seen` bleibt ungesetzt (Flags geprüft und IMAP-Befehle mitgeschnitten: nur `EXAMINE` und `BODY.PEEK[]`, kein `SELECT`/`STORE`/`COPY`/`MOVE`/`EXPUNGE`/`CLOSE` beim Abruf), MOVE → `location_removed` + `upsert` mit gleicher identityKey, Expunge, Schlagwort-, `\Flagged`- und Kopie-Marker (inkl. Schutz einer Nutzerkopie), UIDVALIDITY-Wechsel durch Löschen und Neuanlegen eines Ordners, Ordnerrollen, Zustellung per SMTP, verschwundener Ordner, kein Klartext ohne STARTTLS, falsches Passwort, nicht vertrauenswürdiges Zertifikat, geschlossener Port. Ohne erreichbares GreenMail werden diese Tests übersprungen (Warnung im Log).
- **Mit gemocktem imapflow-Client:** CONDSTORE (Flag-Änderungen, fortsetzbarer Scan), QRESYNC (`VANISHED (EARLIER)` statt SEARCH), `PERMANENTFLAGS` ohne `\*`, TLS-/STARTTLS-Optionen, Anmeldefehler.
- **Mit gemocktem `fetch`:** Gmail (Erstimport, history-Delta, 404-Neuimport, 401 → Refresh → `needs_reauth`, 429/403-Kontingente, Spam nur auf Auftrag, Label-Marker), Graph (Delta mit nextLink/deltaLink, `@removed`, Teil-Updates, 410/`SyncStateNotFound`, 429 mit Retry-After, fremde Links, Kategorie/Flag), OAuth, ISPDB.

GreenMail-Eigenheiten (2.1.3): kein CONDSTORE/QRESYNC/SPECIAL-USE/STARTTLS; UIDVALIDITY ist die Anlage-Sekunde des Ordners; `RFC822.SIZE` meldet nur die Body-Größe; `-Dgreenmail.auth.disabled` schaltet die Anmeldung schon durch bloßes Vorhandensein ab (auch mit `=false`) und ist deshalb entfernt; das Löschen eines Ordners, den eine bereits geschlossene Sitzung ausgewählt hatte, bricht mit einer NullPointerException die löschende Verbindung ab – die Tests leeren Ordner deshalb nur und verwenden für zu löschende Ordner eindeutige Namen. Testkonten: `e2e@`, `alice@` … `frank@example.com` (Passwort `<name>-pass`, Anmeldung mit voller Adresse).

## Bekannte Grenzen

- Gmail `format=raw` lädt die ganze Nachricht, auch über `maxMessageBytes` hinaus (die API bietet keinen Teilabruf von `raw`); gekürzt wird erst beim Parsen.
- Graph: `In-Reply-To`/`References` werden nicht gelesen (Thread über `conversationId`), `sizeBytes` ist `null`; jedes `@removed` kostet eine Nachschlage-Anfrage.
- IMAP: ohne CONDSTORE keine Flag-Änderungen; `SINCE` arbeitet tagesgenau; Ordner-Umbenennungen erscheinen als `folder_missing` plus neuer Ordner.
- `FetchRequest.ownAddresses` wird nicht ausgewertet, weil `NormalizedMessage` kein Feld dafür hat; Adressen werden einheitlich kleingeschrieben, damit der Worker vergleichen kann.

## Quellen (offizielle Dokumentation)

- Gmail: [Synchronisation](https://developers.google.com/workspace/gmail/api/guides/sync), [users.history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), [users.messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [users.messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [Format](https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format), [Message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages), [users.messages.modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify), [Label](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels), [Labels-Leitfaden](https://developers.google.com/workspace/gmail/api/guides/labels), [Filtern/Suche](https://developers.google.com/workspace/gmail/api/guides/filtering), [Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Fehlerbehandlung](https://developers.google.com/workspace/gmail/api/guides/handle-errors), [users.getProfile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile), [IMAP-Erweiterungen](https://developers.google.com/workspace/gmail/imap/imap-extensions)
- Google OAuth: [Web-Server-Apps](https://developers.google.com/identity/protocols/oauth2/web-server), [Native Apps (PKCE)](https://developers.google.com/identity/protocols/oauth2/native-app)
- Microsoft Graph: [message: delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0), [Delta für Nachrichten](https://learn.microsoft.com/en-us/graph/delta-query-messages), [Delta-Überblick](https://learn.microsoft.com/en-us/graph/delta-query-overview), [Immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id), [message](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0), [Anhänge auflisten](https://learn.microsoft.com/en-us/graph/api/message-list-attachments?view=graph-rest-1.0), [Nachricht aktualisieren](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), [followupFlag](https://learn.microsoft.com/en-us/graph/api/resources/followupflag?view=graph-rest-1.0), [outlookCategory](https://learn.microsoft.com/en-us/graph/api/resources/outlookcategory?view=graph-rest-1.0), [mailFolder](https://learn.microsoft.com/en-us/graph/api/resources/mailfolder?view=graph-rest-1.0), [mailFolders auflisten](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0), [Drosselung](https://learn.microsoft.com/en-us/graph/throttling), [Fehler](https://learn.microsoft.com/en-us/graph/errors), [Berechtigungen](https://learn.microsoft.com/en-us/graph/permissions-reference)
- Microsoft Identity Platform: [Autorisierungscode-Flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- Weitere: [iCloud-Mail-Servereinstellungen (Apple)](https://support.apple.com/en-us/102525), [GreenMail](https://greenmail-mail-test.github.io/greenmail/), [Thunderbird-ISPDB](https://github.com/thunderbird/autoconfig), RFC 3501/9051 (IMAP), RFC 6154 (SPECIAL-USE), RFC 6186 (SRV), RFC 7162 (CONDSTORE/QRESYNC), RFC 7636 (PKCE), RFC 8314 (implizites TLS)

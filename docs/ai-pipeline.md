# KI-Verarbeitung

## Ablauf je Mail

1. Mail inkrementell importieren (Worker, `scan_account`).
2. HTML sicher in Text umwandeln; Signaturen und wiederholte Zitate reduzieren (`packages/mail-connectors`).
3. Prüfen, ob die Analyse nötig ist: unveränderter Inhalt (`content_hash` = `analysis_content_hash`) wird nicht erneut analysiert; eigene gesendete Mails nur als Kontext.
4. Budget prüfen (Monat in der Zeitzone des Benutzers, inklusive bezahlter Fehlversuche). Reicht es nicht: Status `budget_paused`, Mails werden weiter erfasst, die App zeigt „noch ungeprüft“.
5. Eingabe bauen: aktuelle Mail (gekürzt auf `maxMessageChars`, gekennzeichnet), frühere Mails des Threads nur als Zusammenfassungen, Kandidaten-Aufgaben (gleicher Thread, offene Aufgaben desselben Absenders), dauerhafte Zuordnungen, bereits gestellte Rückfragen.
6. Modell aufrufen (strukturierte Ausgabe nach JSON-Schema).
7. Schutzregeln anwenden (`packages/ai/src/normalize.ts`), Ergebnis gegen den Vertrag `AnalysisOutput` validieren.
8. In einer Transaktion: Analyse speichern, Aufgaben anlegen oder ergänzen, Rückfragen anlegen, Markierungsauftrag einstellen.

## Adapter

- `Analyzer`-Interface mit zwei Implementierungen: `AnthropicAnalyzer` (Messages API über das offizielle SDK) und `FixtureAnalyzer` (Testdouble, nie in production).
- Modellname nur aus `ANTHROPIC_MODEL`; im Code steht kein Standardmodell. Effort über `ANTHROPIC_EFFORT`.
- Der Systemprompt ist stabil und gecacht; alles Variable steht in der Nutzernachricht. Mailinhalte werden als JSON übergeben, `<` und `>` sind maskiert, damit Mailtext den Eingabeblock nicht verlassen kann.
- Server-seitiger Fallback bei Ablehnungen (`ANTHROPIC_FALLBACKS=default`); die Kosten werden dann mit dem höheren Preis gezählt.
- SDK-Wiederholungen bei 408/409/429/5xx und Verbindungsfehlern (`ANTHROPIC_MAX_RETRIES`), danach höchstens `MAX_ANALYSIS_ATTEMPTS` Jobversuche. Ablehnung (`refusal`), abgeschnittene Antwort und Konfigurationsfehler werden nicht wiederholt.
- Fehlgeschlagene Analysen enden als `failed` mit Grund und sichtbarem Zähler – nie als „keine Aufgabe“.

## Schutzregeln (serverseitig, unabhängig vom Modell)

- Zitate, Fristbelege und Mailausschnitte müssen wörtlich in der Mail stehen, sonst werden sie entfernt; eine Frist ohne Beleg wird als „unsicher“ markiert.
- Keine erfundene Uhrzeit oder Zeitzone: Zeitpunkte nur mit Offset **und** einer Uhrzeit im Beleg, sonst reine Datumsfrist. Ungültige Kalenderdaten werden verworfen.
- Informationsmails (Newsletter, allgemeine Infos) erzeugen keine Aufgaben.
- „Kritisch“ nur mit belegter Dringlichkeit (Frist innerhalb einer Woche oder Beleg im Mailtext); „Urgent“ im Betreff allein reicht nicht.
- Unklare Relevanz führt zu einer Rückfrage; die betroffenen Aufgaben werden erst nach „Betrifft mich“ angelegt.
- Rückfragen erhalten feste Antwortmöglichkeiten (z. B. „Ja“, „Nein“, „Diesmal nicht“, „Weiß ich noch nicht“). Nur „Ja“/„Nein“ mit ausdrücklich „dauerhaft“ erzeugt eine sichtbare, änderbare Zuordnung; „Diesmal nicht“ nie.
- Eine bekannte dauerhafte Zuordnung beantwortet die Frage, statt sie erneut zu stellen.
- Vorgeschlagene bestehende Aufgaben müssen unter den angebotenen Kandidaten sein.
- Checklisten nur bei mindestens zwei echten Schritten aus der Mail.
- Jede Korrektur der Modellausgabe wird in `message_analyses.adjustments` festgehalten.

## Bestehende Aufgaben und Antworten

- Antworten im Thread ergänzen die passende Aufgabe (neue Quelle, neueste Änderung, Verlauf mit Quelle). Thread allein heißt nicht dieselbe Aufgabe.
- Manuelle Titel, Prioritäten, Fristen, Notizen und Status werden nie überschrieben; geänderte KI-Fristen erscheinen im Verlauf mit altem und neuem Wert.
- Erledigte Aufgaben werden nicht wieder geöffnet; eine neue Verpflichtung im Thread wird eine Folgeaufgabe.
- Verworfene Aufgaben entstehen nicht neu. Kommt eine neue Mail dazu, fragt MailPilot, ob sie wieder aufgenommen werden soll.
- Eine Antwort oder eine eigene gesendete Mail setzt nie „Erledigt“; eigene Antworten erscheinen nur im Verlauf.

## Kosten

- `GET /v1/usage`: Verbrauch des Monats in US-Cent (Anthropic rechnet in USD ab), Budget, Tokens, ungeprüfte Mails.
- Preise je Modell sind hinterlegt (Stand 2026-10-06) und per `AI_PRICE_*` überschreibbar. Ohne bekannten Preis startet die Analyse nicht, weil das Budget sonst nicht durchsetzbar wäre.
- Anhänge werden nie heruntergeladen oder an das Modell geschickt; sie erscheinen als Metadaten und als Hinweis „Anhang lesen nötig“.

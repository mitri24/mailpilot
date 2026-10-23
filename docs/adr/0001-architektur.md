# ADR 0001: Architekturentscheidungen und Abweichungen

Status: angenommen · 2026-10-23

Die vorgegebene Architektur (SwiftUI-Clients, Fastify/Zod, PostgreSQL/Drizzle, Graphile Worker, OpenAPI, Cursor-Sync, Docker Compose, Vitest) wird unverändert verwendet. Diese Punkte sind Entscheidungen innerhalb der Vorgabe:

1. **Dienste laufen aus TypeScript-Quellen über `tsx`.** Kein separater Build-Schritt; dieselbe Image-Datei für API, Worker und Migration. Folge: `tsx` ist Laufzeitabhängigkeit.
2. **Schreibsperre je Benutzer.** Jede Schreibtransaktion nimmt zuerst eine Advisory-Sperre je Benutzer. Ohne sie könnte eine früh vergebene, spät committete `change_log`-Sequenz von einem Cursor übersprungen werden. Folge: Schreibvorgänge eines Benutzers laufen nacheinander; Modellaufrufe liegen außerhalb der Transaktion.
3. **Feldweise Konflikterkennung** über `field_versions` statt einer einzigen Version je Aufgabe. So bleiben unabhängige Offline-Änderungen erhalten und ein veralteter Status wird zuverlässig abgelehnt.
4. **OAuth-Rückruf auf dem Server.** Anbieter leiten an `/v1/oauth/callback/<provider>`; der Server tauscht den Code (PKCE) und leitet in die App (`mailpilot://accounts/connected`). Tokens verlassen den Server nie.
5. **Budget in US-Cent.** Anthropic rechnet in USD ab; eine Umrechnung würde einen erfundenen Wechselkurs erfordern.
6. **Keine Anhangsinhalte an die KI.** Anhänge werden nicht geladen; wenn die Aufgabe nur über einen Anhang verständlich ist, wird das sichtbar gekennzeichnet.
7. **Eigene gesendete Mails werden nicht analysiert,** nur als Gesprächskontext genutzt und im Verlauf offener Aufgaben gezeigt. Sie setzen nie „Erledigt“.
8. **KI standardmäßig aus** (`AI_PROVIDER=none`). Ohne Konfiguration bleiben Mails sichtbar ungeprüft; es gibt keine heuristische Ersatz-KI.
9. **Rückfrage-Antwortmöglichkeiten werden serverseitig festgelegt.** Das Modell bestimmt Art, Frage, Grund und Gegenstand; dauerhafte Zuordnungen entstehen nur aus „Ja“/„Nein“ mit ausdrücklich dauerhaftem Umfang.
10. **„Weiß ich noch nicht“ hält die Rückfrage offen** (gekennzeichnet), löst keine Aktion aus und wird nicht erneut per Push gemeldet.

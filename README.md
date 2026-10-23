# MailPilot

Aufgaben aus E-Mails, ohne Abtippen. Ein Hintergrunddienst liest die verbundenen Postfächer, erkennt Aufgaben, formuliert den nächsten Schritt auf Deutsch und legt sie an. Eine native iPhone- und Mac-App zeigt sie in „Heute“, als Kanban-Board und in Widgets, jede Aufgabe mit Zugang zur Originalmail. Apple Mail bleibt das Mailprogramm.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `apps/apple/` | SwiftUI-App für iOS und macOS, Widgets, App Intents, Share Extension |
| `services/api/` | REST-API (Fastify, Zod, OpenAPI) |
| `services/worker/` | Hintergrunddienst (Graphile Worker): Mailabruf, Analyse, Markierung, Zeitplan, Mitteilungen |
| `packages/contracts/` | gemeinsame Schemas (API, Sync, Jobs, KI-Ausgabe) |
| `packages/mail-connectors/` | Gmail API, Microsoft Graph, IMAP/TLS |
| `packages/ai/` | austauschbarer LLM-Adapter (Anthropic), Schutzregeln, Kosten |
| `packages/database/` | PostgreSQL-Schema (Drizzle) und Migrationen |
| `infra/` | Docker Compose, Dockerfile |
| `docs/` | Architektur, Sync, KI, Entscheidungen, Prüfbericht, Inbetriebnahme |

## Voraussetzungen

- Node.js 22 LTS (`.nvmrc`), pnpm 11 (`corepack enable`)
- Docker mit Compose
- Für die Apple-Apps: Xcode 16.3 oder neuer und XcodeGen (siehe [docs/apple.md](docs/apple.md)); die Apps laufen ab iOS 17 und macOS 14

## Lokal starten

```sh
cp .env.example .env                 # Werte nur in .env eintragen
openssl rand -base64 32              # Wert für CREDENTIALS_ENCRYPTION_KEY
docker compose -f infra/docker-compose.yml up -d postgres
pnpm install
DATABASE_URL=postgres://mailpilot:mailpilot@127.0.0.1:55432/mailpilot pnpm db:migrate
pnpm dev:api                         # http://localhost:8787, OpenAPI unter /openapi.json
pnpm dev:worker
```

Alles in Containern (API, Worker, Migration):

```sh
docker compose -f infra/docker-compose.yml --profile app up --build
```

Ohne KI-Zugang läuft alles außer der Analyse: Mails werden abgerufen und als „noch ungeprüft“ angezeigt. Für die Analyse `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` und `ANTHROPIC_MODEL` setzen.

## Ohne echte Postfächer ausprobieren

Der lokale Testserver GreenMail spielt ein IMAP-Postfach, ganz ohne echte Konten.

```sh
docker compose -f infra/docker-compose.yml --profile test up -d greenmail
```

In `.env` zusätzlich `DEV_IMAP_ALLOW_SELF_SIGNED_LOCALHOST=true` setzen. Das erlaubt nur auf 127.0.0.1 das selbstsignierte Zertifikat des Testservers und ist in production gesperrt. In der App dann ein IMAP-Konto verbinden: Server `127.0.0.1`, Port `3993`, Benutzer `e2e@example.com`, Passwort `e2e-pass`. Testmails lassen sich per SMTP an Port `3025` einliefern.

## Befehle

| Befehl | Zweck |
|---|---|
| `pnpm typecheck` | TypeScript-Prüfung aller Pakete |
| `pnpm test` | alle Tests (braucht die Postgres aus Docker Compose) |
| `pnpm db:generate` | Migration aus dem Schema erzeugen |
| `pnpm db:migrate` | Migrationen anwenden |
| `pnpm openapi:export` | `docs/openapi.json` neu schreiben |
| `docker compose -f infra/docker-compose.yml --profile test up -d greenmail` | lokaler IMAP-Server für Connector-Tests |

## Dokumentation

- [Architektur](docs/architecture.md) · [Synchronisierung](docs/sync.md) · [Heute-Ansicht](docs/today.md) · [KI-Verarbeitung](docs/ai-pipeline.md)
- [Mail-Anbindung und Markierung](docs/mail-connectors.md) · [Apple-Clients](docs/apple.md)
- [Entscheidungen](docs/adr/) · [Prüfbericht Abschlussszenario](docs/scenario-report.md) · [Inbetriebnahme](docs/inbetriebnahme.md)
- API: [docs/openapi.json](docs/openapi.json)

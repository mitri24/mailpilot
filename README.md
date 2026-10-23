# MailPilot

Aufgaben aus E-Mails, ohne Abtippen. Ein Hintergrunddienst liest die verbundenen Postfächer, erkennt Aufgaben, formuliert den nächsten Schritt auf Deutsch und legt sie an. Eine native iPhone- und Mac-App zeigt sie als Kanban-Board und in Widgets, jede Aufgabe mit Zugang zur Originalmail. Apple Mail bleibt das Mailprogramm.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `apps/apple/` | SwiftUI-App für iOS und macOS, Widgets, App Intents |
| `services/api/` | REST-API (Fastify, TypeScript) |
| `services/worker/` | Hintergrunddienst für Mailabruf und Analyse |
| `packages/contracts/` | gemeinsame Schemas und OpenAPI |
| `packages/mail-connectors/` | Gmail, Microsoft Graph, IMAP |
| `packages/ai/` | austauschbarer LLM-Adapter |
| `packages/database/` | PostgreSQL-Schema und Migrationen |
| `infra/` | Docker Compose und Betrieb |
| `docs/` | Architektur und Entscheidungen |

## Status

Im Aufbau, noch kein lauffähiger Code.

# Synchronisierung

Das Backend ist die Quelle, jedes Gerät hält einen lokalen SQLite-Cache (GRDB) und eine persistente Outbox.

## Änderungen holen

`GET /v1/sync/changes?cursor=<seq>&limit=500`

- Ohne Cursor: vollständiger Stand aller Entitäten (Einstellungen, Konten, Aufgaben, Notizen, Checklisten, Rückfragen, Zuordnungen) und der aktuelle Cursor.
- Mit Cursor: alle Einträge nach `seq`, je Entität nur der neueste, mit dem **aktuellen** Zustand. `op: "delete"` und `data: null` sind Tombstones (gelöschte Notiz, entfernte Zuordnung, entferntes Konto).
- `hasMore: true` → mit `nextCursor` weiterblättern.
- `resetRequired: true` → der Cursor stammt nicht von diesem Server (z. B. nach einem Datenbank-Reset). Cursor verwerfen und vollständig neu laden; die Outbox bleibt erhalten.
- Cursor und Zustände stammen aus einem konsistenten Snapshot (Repeatable Read). Schreibtransaktionen eines Benutzers sind serialisiert, deshalb gilt: ist `seq` sichtbar, sind alle kleineren Einträge dieses Benutzers committet.

## Änderungen senden

`POST /v1/sync/mutations` mit bis zu 100 Mutationen in Outbox-Reihenfolge. Jede Mutation trägt einen UUID-Idempotency-Key.

| Ergebnis | Bedeutung | Client |
|---|---|---|
| `applied` | übernommen | aus der Outbox entfernen |
| `duplicate` | Objekt mit dieser ID existiert schon (z. B. Wiederholung) | entfernen |
| `conflict` | Teile wurden nicht übernommen (`conflictingFields`) | Serverstand übernehmen, Konflikt anzeigen |
| `rejected` | ungültig (nicht gefunden, Key für andere Änderung benutzt) | entfernen, Fehler anzeigen |

Dieselbe Mutation mit demselben Key liefert immer dieselbe gespeicherte Antwort (`mutation_receipts`). Derselbe Key für eine andere Änderung wird abgelehnt.

## Konflikte

- **Aufgaben**: feldweise. Jede Aufgabe speichert je Feld die Version der letzten Änderung (`field_versions`). Ein Feld wird nur übernommen, wenn es seit der `baseVersion` des Geräts nicht geändert wurde. Beispiel: Gerät A setzt offline „Doing“ (Basis v3), Gerät B erledigt die Aufgabe (v4). Kommt A online, meldet der Server `conflict` mit `["status"]`; die Aufgabe bleibt erledigt. Andere Felder derselben Mutation werden trotzdem übernommen.
- **Notizen**: eine veraltete Bearbeitung überschreibt nie. Der Server legt die konkurrierende Fassung als eigene Notiz an (`conflictOfNoteId`, `createdEntityId` im Ergebnis); beide bleiben erhalten.
- **Checklisten**: Abhaken lässt sich immer zusammenführen, Titeländerungen brauchen die aktuelle Version.
- **Rückfragen**: eine zweite, andere Antwort ist ein Konflikt; dieselbe Antwort ist idempotent.

## Client-Ablauf

1. Lokale Änderung sofort im Cache anwenden und als Mutation in die Outbox schreiben.
2. Outbox senden (beim Öffnen, nach Änderungen, manuell, nach Netzwerkfehlern mit Backoff, immer mit denselben Keys).
3. Änderungen holen bis `hasMore=false`, Cache aktualisieren.
4. Widget-Snapshot schreiben und Widgets neu laden.

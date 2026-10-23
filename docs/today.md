# Tagesansicht „Heute“

Die Reihenfolge ist nachvollziehbar und identisch auf Server (`services/api/src/domain/today.ts`) und Client (offline).

Berücksichtigt werden Aufgaben mit Status To Do oder Doing, die nicht auf eine Antwort warten und nicht bis später zurückgestellt sind.

| Rang | Kriterium |
|---|---|
| 0 | Belegte Frist heute, in den nächsten zwei Tagen oder überfällig (vorgeschlagene Bearbeitungstermine zählen nicht als Frist) |
| 1 | Von mir für heute eingeplant (`plannedFor`) |
| 2 | Kritisch |
| 3 | Wichtig |
| 4 | Kann warten |

Innerhalb von Rang 0 entscheidet die Frist. In allen anderen Rängen gilt meine manuelle Sortierung (`sortKey`), danach die Frist, danach das Alter.

- „Die drei nächsten“ sind die ersten drei Einträge.
- Weitere kritische oder bald fällige Aufgaben erscheinen getrennt darunter und werden nie abgeschnitten.
- „Auf morgen verschieben“ setzt nur `plannedFor` und verändert keine Frist. Liegt morgen nach der Frist, zeigt die App einen sachlichen Hinweis.
- Alte Aufgaben werden nie automatisch auf heute geschoben.
- „Kann warten“ bleibt über einen eigenen Zähler und Filter erreichbar; wartende Aufgaben über den Filter „Warte auf Antwort“.
- Zusätzlich: offene Rückfragen, Zeitpunkt der letzten erfolgreichen Aktualisierung, ungeprüfte Mails und Konten mit Fehler samt konkreter Handlung. „Keine Aufgaben“ wird nie gezeigt, solange Mails ungeprüft sind.

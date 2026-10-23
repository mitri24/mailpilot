/**
 * Erzeugt MailPilotKit/Tests/MailPilotKitTests/Fixtures/today-parity.json mit dem echten Server-Ranking
 * (services/api/src/domain/today.ts). Die Swift-Tests rechnen dieselben Fälle lokal nach.
 *
 *   node_modules/.bin/tsx apps/apple/Tools/today-parity.ts   (im Repository-Wurzelverzeichnis)
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Task, type Task as TaskT } from "../../../packages/contracts/src/index.ts";
import { addDays, dueDate, isActionableNow, localDate, rankTask, sortForToday } from "../../../services/api/src/domain/today.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../MailPilotKit/Tests/MailPilotKitTests/Fixtures/today-parity.json");
const TZ = "Europe/Paris";

let counter = 0;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dl = (date: string, kind: "explicit" | "uncertain" | "suggested" = "explicit") => ({ date, dateTime: null, precision: "date" as const, kind, sourceQuote: null });
const dlAt = (dateTime: string, kind: "explicit" | "uncertain" | "suggested" = "explicit") => ({ date: null, dateTime, precision: "datetime" as const, kind, sourceQuote: null });

function task(title: string, over: Partial<TaskT> = {}): TaskT {
  counter += 1;
  const createdAt = new Date(Date.UTC(2026, 0, 1, 8, 0, counter)).toISOString();
  const base: TaskT = {
    id: id(counter),
    version: 1,
    origin: "ai",
    status: "todo",
    waiting: false,
    waitingCheckAt: null,
    snoozedUntil: null,
    plannedFor: null,
    sortKey: null,
    title,
    nextStep: null,
    summary: null,
    priority: "important",
    priorityReason: null,
    priorityIsManual: false,
    deadline: null,
    deadlineIsManual: false,
    why: null,
    requiresAttachmentReading: false,
    estimatedMinutes: null,
    estimateSource: null,
    ai: { title, nextStep: null, summary: null, priority: over.priority ?? "important", priorityReason: null, deadline: over.deadline ?? null, why: null },
    manual: { title: null, nextStep: null, priority: null, deadline: null, deadlineCleared: false },
    accountIds: [],
    primarySource: null,
    sourceCount: 0,
    openClarifications: 0,
    latestChange: null,
    doneAt: null,
    dismissedAt: null,
    mergedIntoTaskId: null,
    createdAt,
    updatedAt: createdAt,
  };
  return Task.parse({ ...base, ...over });
}

function scenario(name: string, now: string, build: (today: string) => TaskT[]) {
  const nowDate = new Date(now);
  const today = localDate(nowDate, TZ);
  const tasks = build(today);
  // Wie computeToday (services/api/src/domain/today.ts), ohne Datenbank.
  const all = tasks.filter((t) => (t.status === "todo" || t.status === "doing") && t.mergedIntoTaskId === null);
  const actionable = sortForToday(all.filter((t) => isActionableNow(t, nowDate)), today, TZ);
  const next = actionable.slice(0, 3);
  const moreUrgent = actionable.slice(3).filter((t) => {
    const due = dueDate(t, TZ);
    return (due !== null && due <= addDays(today, 2)) || t.priority === "critical";
  });
  return {
    name,
    now,
    timeZone: TZ,
    today,
    tasks,
    expected: {
      ranks: Object.fromEntries(tasks.map((t) => [t.id, rankTask(t, today, TZ)])),
      dueDates: Object.fromEntries(tasks.map((t) => [t.id, dueDate(t, TZ)])),
      actionable: Object.fromEntries(tasks.map((t) => [t.id, isActionableNow(t, nowDate)])),
      sortedActionableIds: actionable.map((t) => t.id),
      nextIds: next.map((t) => t.id),
      moreUrgentIds: moreUrgent.map((t) => t.id),
      waitingCount: all.filter((t) => t.waiting).length,
      canWaitCount: all.filter((t) => t.priority === "can_wait" && !next.includes(t)).length,
    },
  };
}

const scenarios = [
  // Freitag, 23.10.2026, 10:00 in Paris; Ende der Sommerzeit am 25.10.
  scenario("herbst-sommerzeitende", "2026-10-23T08:00:00.000Z", (today) => [
    task("Überfällig, kann warten", { priority: "can_wait", deadline: dl(addDays(today, -3)) }),
    task("Heute fällig", { deadline: dl(today) }),
    task("Übermorgen, unsicher erkannt", { priority: "can_wait", deadline: dl(addDays(today, 2), "uncertain") }),
    task("In drei Tagen fällig", { deadline: dl(addDays(today, 3)) }),
    task("Nur Vorschlag heute", { priority: "can_wait", deadline: dl(today, "suggested") }),
    task("Heute eingeplant", { plannedFor: today }),
    task("Gestern eingeplant", { priority: "can_wait", plannedFor: addDays(today, -1) }),
    task("Morgen eingeplant, kritisch", { priority: "critical", plannedFor: addDays(today, 1) }),
    task("Kritisch, Reihenfolge 2", { priority: "critical", sortKey: 2 }),
    task("Kritisch, Reihenfolge 1", { priority: "critical", sortKey: 1 }),
    task("Kritisch ohne Reihenfolge", { priority: "critical" }),
    task("Wichtig, Reihenfolge 0.5", { sortKey: 0.5 }),
    task("Warte auf Antwort", { priority: "critical", waiting: true, waitingCheckAt: addDays(today, 4) }),
    task("Später anzeigen (Zukunft)", { priority: "critical", snoozedUntil: "2026-10-24T06:00:00.000Z" }),
    task("Später anzeigen (vorbei)", { snoozedUntil: "2026-10-22T06:00:00.000Z" }),
    task("Erledigt", { priority: "critical", status: "done", doneAt: "2026-10-22T10:00:00.000Z" }),
    task("Nicht relevant", { priority: "critical", status: "dismissed", dismissedAt: "2026-10-22T10:00:00.000Z" }),
    task("Zusammengeführt", { priority: "critical", mergedIntoTaskId: id(1) }),
    task("Frist 25.10. 23:30 Pariser Zeit", { deadline: dlAt("2026-10-25T22:30:00.000Z") }),
    task("Frist 26.10. 00:30 Pariser Zeit", { deadline: dlAt("2026-10-25T23:30:00.000Z") }),
    task("In Arbeit, morgen fällig", { status: "doing", deadline: dl(addDays(today, 1)) }),
    task("Keine Frist (manuell entfernt), kritisch", { priority: "critical", deadlineIsManual: true }),
    task("Kann warten ohne Frist", { priority: "can_wait" }),
    task("Wartend und kann warten", { priority: "can_wait", waiting: true }),
  ]),
  // Beginn der Sommerzeit: 29.03.2026 23:30 UTC ist schon der 30.03. in Paris.
  scenario("fruehling-sommerzeitbeginn", "2026-03-29T23:30:00.000Z", (today) => [
    task("Frist 01.04. 23:59 Pariser Zeit", { deadline: dlAt("2026-04-01T21:59:00.000Z") }),
    task("Frist 02.04. 00:00 Pariser Zeit", { priority: "can_wait", deadline: dlAt("2026-04-01T22:00:00.000Z") }),
    task("Reine Datumsfrist 01.04.", { priority: "can_wait", deadline: dl("2026-04-01") }),
    task("Gestern UTC, heute Paris eingeplant", { plannedFor: today }),
    task("Vorschlag überfällig", { priority: "critical", deadline: dl("2026-03-20", "suggested") }),
    task("Kritisch", { priority: "critical" }),
    task("Wichtig", {}),
  ]),
  // Jahreswechsel in Paris (UTC noch im alten Jahr).
  scenario("jahreswechsel", "2026-12-31T23:30:00.000Z", (today) => [
    task("Am 31.12. eingeplant", { plannedFor: "2026-12-31" }),
    task("Frist 03.01.2027", { priority: "can_wait", deadline: dl("2027-01-03") }),
    task("Frist 04.01.2027", { deadline: dl("2027-01-04") }),
    task("Kritisch A", { priority: "critical", sortKey: -1 }),
    task("Kritisch B", { priority: "critical" }),
    task("Kritisch C", { priority: "critical" }),
    task("Kann warten", { priority: "can_wait" }),
    task("Frist heute", { priority: "can_wait", deadline: dl(today) }),
  ]),
];

writeFileSync(out, JSON.stringify({ generatedBy: "apps/apple/Tools/today-parity.ts", source: "services/api/src/domain/today.ts", scenarios }, null, 2) + "\n");
console.log(`today-parity.json: ${scenarios.length} Szenarien, ${scenarios.reduce((n, s) => n + s.tasks.length, 0)} Aufgaben → ${out}`);

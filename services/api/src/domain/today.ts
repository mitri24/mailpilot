import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { addDays, localDate, type Task, type Today } from "@mailpilot/contracts";
import { schema, type Database } from "@mailpilot/database";
import { iso } from "./dto.js";
import { tasksToDto } from "./task-queries.js";

const { tasks, clarificationRequests, mailAccounts, messages } = schema;

export { addDays, localDate } from "@mailpilot/contracts";

/** Local due date of a task's effective deadline; suggested working dates are not deadlines. */
export function dueDate(task: Task, timeZone: string): string | null {
  const d = task.deadline;
  if (!d || d.kind === "suggested") return null;
  if (d.precision === "date") return d.date;
  return d.dateTime ? localDate(new Date(d.dateTime), timeZone) : null;
}

/**
 * Ranking for "Heute" (documented in docs/today.md; the Apple client mirrors it offline):
 * 0 evidenced deadline within two days or overdue · 1 planned for today · 2 critical · 3 important · 4 can wait.
 * Within a rank: deadline first for rank 0, otherwise manual sort key, then deadline, then age.
 */
export function rankTask(task: Task, today: string, timeZone: string): number {
  const due = dueDate(task, timeZone);
  if (due && due <= addDays(today, 2)) return 0;
  if (task.plannedFor && task.plannedFor <= today) return 1;
  if (task.priority === "critical") return 2;
  if (task.priority === "important") return 3;
  return 4;
}

export function sortForToday(list: Task[], today: string, timeZone: string): Task[] {
  const key = (t: Task) => ({ rank: rankTask(t, today, timeZone), due: dueDate(t, timeZone) ?? "9999-12-31" });
  return [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka.rank !== kb.rank) return ka.rank - kb.rank;
    if (ka.rank === 0 && ka.due !== kb.due) return ka.due < kb.due ? -1 : 1;
    const sa = a.sortKey ?? Number.POSITIVE_INFINITY;
    const sb = b.sortKey ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    if (ka.due !== kb.due) return ka.due < kb.due ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

export function isActionableNow(task: Task, now: Date): boolean {
  if (task.status !== "todo" && task.status !== "doing") return false;
  if (task.waiting) return false;
  if (task.snoozedUntil && new Date(task.snoozedUntil) > now) return false;
  return true;
}

export async function computeToday(db: Database, userId: string, timeZone: string, now = new Date()): Promise<Today> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, ["todo", "doing"]), isNull(tasks.deletedAt), isNull(tasks.mergedIntoTaskId)));
  const all = await tasksToDto(db, rows);
  const today = localDate(now, timeZone);
  const actionable = sortForToday(
    all.filter((t) => isActionableNow(t, now)),
    today,
    timeZone,
  );
  const next = actionable.slice(0, 3);
  const moreUrgent = actionable.slice(3).filter((t) => {
    const due = dueDate(t, timeZone);
    return (due !== null && due <= addDays(today, 2)) || t.priority === "critical";
  });

  const [clar] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clarificationRequests)
    .where(and(eq(clarificationRequests.userId, userId), eq(clarificationRequests.status, "open")));

  const accounts = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.userId, userId), isNull(mailAccounts.removedAt)));
  const accountIds = accounts.map((a) => a.id);
  const [pending] = accountIds.length
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(inArray(messages.accountId, accountIds), inArray(messages.analysisStatus, ["pending", "budget_paused"]), isNull(messages.deletedAt)))
    : [{ count: 0 }];
  const lastFetch = accounts
    .filter((a) => a.status === "active")
    .map((a) => a.lastSuccessfulFetchAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const attention = accounts
    .filter(
      (a) =>
        a.status === "error" ||
        a.status === "needs_reauth" ||
        (a.lastErrorAt !== null && (a.lastSuccessfulFetchAt === null || a.lastErrorAt > a.lastSuccessfulFetchAt)),
    )
    .map((a) => ({
      accountId: a.id,
      displayName: a.displayName,
      problem: a.lastErrorMessage ?? "Letzter Abruf fehlgeschlagen",
      action: a.lastErrorAction ?? (a.status === "needs_reauth" ? "Konto erneut verbinden" : "Verbindung prüfen"),
    }));

  return {
    next,
    moreUrgent,
    waitingCount: all.filter((t) => t.waiting).length,
    canWaitCount: all.filter((t) => t.priority === "can_wait" && !next.includes(t)).length,
    openClarifications: clar?.count ?? 0,
    lastSuccessfulUpdateAt: iso(lastFetch ?? null),
    pendingAnalysisCount: pending?.count ?? 0,
    accountsNeedingAttention: attention,
    generatedAt: now.toISOString(),
  };
}

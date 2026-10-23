import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Jobs, type ScanRun } from "@mailpilot/contracts";
import { schema, type Database } from "@mailpilot/database";
import { ApiError, notFound } from "../errors.js";
import type { JobQueue } from "../queue.js";
import { iso } from "./dto.js";

const { processingRuns, mailAccounts } = schema;
type RunRow = typeof processingRuns.$inferSelect;

export const toRunDto = (r: RunRow): ScanRun => ({
  id: r.id,
  accountId: r.accountId,
  kind: r.kind as ScanRun["kind"],
  trigger: r.trigger as ScanRun["trigger"],
  status: r.status as ScanRun["status"],
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
  stats: r.stats,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
});

/** Queues one scan per active account; a scan already queued for an account is replaced, never doubled. */
export async function requestScan(
  db: Database,
  queue: JobQueue,
  userId: string,
  accountId: string | undefined,
  trigger: "manual" | "onboarding" = "manual",
): Promise<ScanRun[]> {
  const accounts = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.userId, userId), isNull(mailAccounts.removedAt), accountId ? eq(mailAccounts.id, accountId) : undefined));
  if (accountId && accounts.length === 0) throw notFound("Konto");
  const active = accounts.filter((a) => a.status === "active" || a.status === "error");
  if (active.length === 0) throw new ApiError(409, "no_active_account", "Kein aktives Postfach verbunden");
  const runs: RunRow[] = [];
  for (const account of active) {
    // A run that is still queued is reused; the job key keeps one pending scan per account.
    const [queued] = await db
      .select()
      .from(processingRuns)
      .where(and(eq(processingRuns.accountId, account.id), eq(processingRuns.status, "queued")))
      .limit(1);
    const run = queued ?? (await db.insert(processingRuns).values({ userId, accountId: account.id, kind: "scan", trigger, status: "queued" }).returning())[0]!;
    await queue.add(Jobs.scanAccount, { accountId: account.id, trigger: run.trigger, runId: run.id }, { jobKey: `scan:${account.id}` });
    runs.push(run);
  }
  return runs.map(toRunDto);
}

export async function getRun(db: Database, userId: string, runId: string): Promise<ScanRun> {
  const rows = await db.select().from(processingRuns).where(and(eq(processingRuns.id, runId), eq(processingRuns.userId, userId))).limit(1);
  if (!rows[0]) throw notFound("Lauf");
  return toRunDto(rows[0]);
}

export async function listRuns(db: Database, userId: string, limit = 20, statuses?: string[]): Promise<ScanRun[]> {
  const rows = await db
    .select()
    .from(processingRuns)
    .where(and(eq(processingRuns.userId, userId), statuses ? inArray(processingRuns.status, statuses) : undefined))
    .orderBy(desc(processingRuns.createdAt))
    .limit(limit);
  return rows.map(toRunDto);
}

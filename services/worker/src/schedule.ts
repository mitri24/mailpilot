import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Jobs, localDate, localTime } from "@mailpilot/contracts";
import { estimateCostMicros } from "@mailpilot/ai";
import { schema } from "@mailpilot/database";
import type { UserRow, WorkerDeps } from "./deps.js";
import { monthSpendMicros } from "./analyze.js";
import { runNotifications } from "./notify.js";
import { enqueueAnalysis } from "./scan.js";

const { users, mailAccounts, processingRuns, messages, markerOperations } = schema;

/** Starts one scan per usable account; an account with a queued run is not queued twice. */
export async function startScans(deps: WorkerDeps, userId: string, trigger: "schedule" | "manual" | "retry" | "onboarding"): Promise<number> {
  const accounts = await deps.db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.userId, userId), isNull(mailAccounts.removedAt), inArray(mailAccounts.status, ["active", "error"])));
  let started = 0;
  for (const account of accounts) {
    const [queued] = await deps.db
      .select({ id: processingRuns.id })
      .from(processingRuns)
      .where(and(eq(processingRuns.accountId, account.id), eq(processingRuns.status, "queued")))
      .limit(1);
    const runId =
      queued?.id ?? (await deps.db.insert(processingRuns).values({ userId, accountId: account.id, kind: "scan", trigger, status: "queued" }).returning())[0]!.id;
    await deps.enqueue(Jobs.scanAccount, { accountId: account.id, trigger, runId }, { jobKey: `scan:${account.id}` });
    started++;
  }
  return started;
}

/** Budget-paused mails go back into the queue as soon as the (new month's or raised) budget allows. */
async function resumePaused(deps: WorkerDeps, user: UserRow): Promise<void> {
  if (!deps.analyzer || !deps.prices) return;
  const paused = await deps.db
    .select({ id: messages.id, chars: sql<number>`length(${messages.bodyText})::int` })
    .from(messages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
    .where(and(eq(mailAccounts.userId, user.id), eq(messages.analysisStatus, "budget_paused"), isNull(messages.deletedAt)))
    .limit(50);
  if (paused.length === 0) return;
  let available = user.aiMonthlyBudgetCents * 10_000 - (await monthSpendMicros(deps.db, user, deps.now()));
  const resume: string[] = [];
  for (const p of paused) {
    const estimate = estimateCostMicros(Math.min(p.chars, user.maxMessageChars) + 14_000, deps.expectedOutputTokens, deps.prices);
    if (estimate > available) break;
    available -= estimate;
    resume.push(p.id);
  }
  if (resume.length === 0) return;
  await deps.db.update(messages).set({ analysisStatus: "pending", analysisError: null }).where(inArray(messages.id, resume));
  await enqueueAnalysis(deps, user.id, resume, null);
}

/** Lost jobs (crash between commit and enqueue) are picked up again. */
async function safetyNet(deps: WorkerDeps): Promise<void> {
  const tenMinutesAgo = new Date(deps.now().getTime() - 10 * 60_000);
  const ops = await deps.db
    .select({ id: markerOperations.id })
    .from(markerOperations)
    .where(and(eq(markerOperations.status, "pending"), lt(markerOperations.updatedAt, tenMinutesAgo)))
    .limit(100);
  for (const op of ops) await deps.enqueue(Jobs.applyMarker, { markerOperationId: op.id }, { jobKey: `marker:${op.id}`, maxAttempts: 5 });

  if (!deps.analyzer) return;
  const stale = await deps.db
    .select({ id: messages.id, userId: mailAccounts.userId })
    .from(messages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
    .where(
      and(
        eq(messages.analysisStatus, "pending"),
        isNull(messages.deletedAt),
        isNull(mailAccounts.removedAt),
        or(lt(messages.updatedAt, new Date(deps.now().getTime() - 30 * 60_000)), isNull(messages.updatedAt)),
      ),
    )
    .limit(200);
  const byUser = new Map<string, string[]>();
  for (const s of stale) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s.id]);
  for (const [userId, ids] of byUser) await enqueueAnalysis(deps, userId, ids, null);
}

/** Runs every few minutes: daily scan at the user's local time, optional extra scans, notifications. */
export async function scheduledTick(deps: WorkerDeps): Promise<void> {
  const now = deps.now();
  const all = await deps.db.select().from(users);
  for (const user of all) {
    const today = localDate(now, user.timezone);
    const time = localTime(now, user.timezone);
    if (user.scanEnabled && time >= user.scanTime && user.lastScheduledScanOn !== today) {
      // The conditional update claims today's scan exactly once, even with several workers.
      const claimed = await deps.db
        .update(users)
        .set({ lastScheduledScanOn: today })
        .where(and(eq(users.id, user.id), or(isNull(users.lastScheduledScanOn), sql`${users.lastScheduledScanOn} <> ${today}`)))
        .returning({ id: users.id });
      if (claimed.length > 0) await startScans(deps, user.id, "schedule");
    } else if (user.scanEnabled && user.extraScanIntervalMinutes) {
      const due = new Date(now.getTime() - user.extraScanIntervalMinutes * 60_000);
      const claimed = await deps.db
        .update(users)
        .set({ lastExtraScanAt: now })
        .where(and(eq(users.id, user.id), or(isNull(users.lastExtraScanAt), lt(users.lastExtraScanAt, due))))
        .returning({ id: users.id });
      if (claimed.length > 0) await startScans(deps, user.id, "schedule");
    }
    await resumePaused(deps, user);
    await runNotifications(deps, user, now);
  }
  await safetyNet(deps);
}

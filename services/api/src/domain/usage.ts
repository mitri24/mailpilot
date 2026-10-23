import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { localMonthStart, type Usage } from "@mailpilot/contracts";
import { schema, type Executor } from "@mailpilot/database";

const { messageAnalyses, messages, mailAccounts, users } = schema;

/** Start of the user's current calendar month in their time zone. */
export const monthStart = (now: Date, timeZone: string) => localMonthStart(now, timeZone);

export async function getUsage(db: Executor, userId: string, now = new Date()): Promise<Usage> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const timezone = user?.timezone ?? "Europe/Paris";
  const { month, start } = monthStart(now, timezone);
  const [agg] = await db
    .select({
      cost: sql<string>`coalesce(sum(${messageAnalyses.costMicros}), 0)::text`,
      input: sql<number>`coalesce(sum(${messageAnalyses.inputTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${messageAnalyses.outputTokens}), 0)::int`,
      analyzed: sql<number>`count(*) filter (where ${messageAnalyses.status} = 'succeeded')::int`,
    })
    .from(messageAnalyses)
    .where(and(eq(messageAnalyses.userId, userId), gte(messageAnalyses.createdAt, start)));
  const accountIds = (await db.select({ id: mailAccounts.id }).from(mailAccounts).where(eq(mailAccounts.userId, userId))).map((a) => a.id);
  const [pending] = accountIds.length
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(inArray(messages.accountId, accountIds), inArray(messages.analysisStatus, ["pending", "budget_paused"]), isNull(messages.deletedAt)))
    : [{ count: 0 }];
  const spentCents = Number(agg?.cost ?? "0") / 10_000;
  const budgetCents = user?.aiMonthlyBudgetCents ?? 0;
  return {
    month,
    spentCents: Math.round(spentCents * 100) / 100,
    budgetCents,
    budgetReached: spentCents >= budgetCents,
    pendingAnalysisCount: pending?.count ?? 0,
    analyzedThisMonth: agg?.analyzed ?? 0,
    inputTokens: agg?.input ?? 0,
    outputTokens: agg?.output ?? 0,
  };
}

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Account } from "@mailpilot/contracts";
import { schema, type Executor } from "@mailpilot/database";
import { toAccountDto } from "./dto.js";

const { mailAccounts, messages, markerOperations } = schema;

export async function loadAccountDtos(db: Executor, userId: string, ids?: string[]): Promise<Account[]> {
  const rows = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.userId, userId), ids ? inArray(mailAccounts.id, ids) : isNull(mailAccounts.removedAt)));
  if (rows.length === 0) return [];
  const accountIds = rows.map((r) => r.id);
  const pending = await db
    .select({ accountId: messages.accountId, count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        inArray(messages.accountId, accountIds),
        inArray(messages.analysisStatus, ["pending", "budget_paused", "failed"]),
        isNull(messages.deletedAt),
      ),
    )
    .groupBy(messages.accountId);
  const failures = await db
    .select({ accountId: markerOperations.accountId, count: sql<number>`count(*)::int` })
    .from(markerOperations)
    .where(and(inArray(markerOperations.accountId, accountIds), eq(markerOperations.status, "failed")))
    .groupBy(markerOperations.accountId);
  const pendingBy = new Map(pending.map((p) => [p.accountId, p.count]));
  const failBy = new Map(failures.map((f) => [f.accountId, f.count]));
  return rows
    .filter((r) => ids || !r.removedAt)
    .map((r) => toAccountDto(r, { pendingAnalysisCount: pendingBy.get(r.id) ?? 0, markerFailures: failBy.get(r.id) ?? 0 }));
}

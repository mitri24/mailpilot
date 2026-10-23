import { sql } from "drizzle-orm";
import type { Database, Executor, Tx } from "./client.js";
import { changeLog, taskEvents } from "./schema.js";

export type EntityType = "task" | "note" | "checklist_item" | "clarification" | "account" | "rule" | "settings";

/**
 * Every client-visible change goes through here, inside the same transaction as the change
 * itself and within `userTransaction`. The sequence number is the sync cursor; deletes become tombstones.
 */
export async function recordChange(
  tx: Executor,
  entry: { userId: string; entityType: EntityType; entityId: string; op: "upsert" | "delete"; version: number },
): Promise<void> {
  await tx.insert(changeLog).values(entry);
}

export async function recordTaskEvent(
  tx: Executor,
  event: {
    taskId: string;
    kind: string;
    actor: "ai" | "user" | "system";
    summary: string;
    messageId?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
  },
): Promise<void> {
  await tx.insert(taskEvents).values({
    taskId: event.taskId,
    kind: event.kind,
    actor: event.actor,
    summary: event.summary,
    messageId: event.messageId ?? null,
    oldValue: event.oldValue === undefined ? null : (event.oldValue as object),
    newValue: event.newValue === undefined ? null : (event.newValue as object),
  });
}

/** Serializes concurrent writers for one key within a transaction (released on commit/rollback). */
export async function advisoryLock(tx: Executor, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Write transaction for one user's syncable data. The per-user lock is held until commit, so
 * change-log sequence numbers of one user are in commit order and a delta cursor never skips a
 * change that commits late. Taken first, before any row lock, to keep one lock order.
 */
export async function userTransaction<T>(db: Database, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await advisoryLock(tx, `user:${userId}`);
    return fn(tx);
  });
}

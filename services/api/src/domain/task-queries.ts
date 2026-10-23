import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Executor } from "@mailpilot/database";
import type { Task } from "@mailpilot/contracts";
import { emptyExtras, iso, toTaskDto, type TaskExtras } from "./dto.js";

const { tasks, taskSources, messages, clarificationRequests } = schema;

export async function loadTaskExtras(db: Executor, taskIds: string[]): Promise<Map<string, TaskExtras>> {
  const result = new Map<string, TaskExtras>();
  if (taskIds.length === 0) return result;
  for (const id of taskIds) result.set(id, { ...emptyExtras, accountIds: [] });

  const sourceRows = await db
    .select({
      taskId: taskSources.taskId,
      role: taskSources.role,
      createdAt: taskSources.createdAt,
      messageId: messages.id,
      accountId: messages.accountId,
      subject: messages.subject,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      sentAt: messages.sentAt,
    })
    .from(taskSources)
    .innerJoin(messages, eq(messages.id, taskSources.messageId))
    .where(and(inArray(taskSources.taskId, taskIds), isNull(taskSources.removedAt)));

  for (const row of sourceRows) {
    const extras = result.get(row.taskId);
    if (!extras) continue;
    extras.sourceCount += 1;
    if (!extras.accountIds.includes(row.accountId)) extras.accountIds.push(row.accountId);
    const candidate = {
      messageId: row.messageId,
      accountId: row.accountId,
      subject: row.subject,
      fromName: row.fromName,
      fromAddress: row.fromAddress,
      sentAt: iso(row.sentAt),
    };
    // The primary source is the origin mail; otherwise the earliest linked mail.
    if (!extras.primarySource || row.role === "origin") extras.primarySource = candidate;
  }

  const clarRows = await db
    .select({ taskId: clarificationRequests.taskId, count: sql<number>`count(*)::int` })
    .from(clarificationRequests)
    .where(and(inArray(clarificationRequests.taskId, taskIds), eq(clarificationRequests.status, "open")))
    .groupBy(clarificationRequests.taskId);
  for (const row of clarRows) {
    if (row.taskId) {
      const extras = result.get(row.taskId);
      if (extras) extras.openClarifications = row.count;
    }
  }
  return result;
}

export async function tasksToDto(db: Executor, rows: Array<typeof tasks.$inferSelect>): Promise<Task[]> {
  const extras = await loadTaskExtras(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toTaskDto(r, extras.get(r.id)));
}

export async function getTaskDto(db: Executor, userId: string, taskId: string): Promise<Task | null> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .limit(1);
  if (!rows[0]) return null;
  const [dto] = await tasksToDto(db, rows);
  return dto ?? null;
}

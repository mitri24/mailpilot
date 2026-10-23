import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Correction, ManualDeadline, TaskCreate, TaskDetail } from "@mailpilot/contracts";
import { recordChange, recordTaskEvent, schema, type Executor, type Tx } from "@mailpilot/database";
import { ApiError, notFound } from "../errors.js";
import { iso, toChecklistDto, toEventDto, toNoteDto } from "./dto.js";
import { getTaskDto } from "./task-queries.js";
import { updateTask } from "./mutations.js";

const { tasks, taskSources, taskNotes, taskChecklistItems, taskEvents, taskMerges, messages, mailAccounts } = schema;

export async function getTaskDetail(db: Executor, userId: string, taskId: string): Promise<TaskDetail> {
  const task = await getTaskDto(db, userId, taskId);
  if (!task) throw notFound("Aufgabe");
  const sourceRows = await db
    .select({ source: taskSources, message: messages })
    .from(taskSources)
    .innerJoin(messages, eq(messages.id, taskSources.messageId))
    .where(and(eq(taskSources.taskId, taskId), isNull(taskSources.removedAt)))
    .orderBy(asc(messages.sentAt));
  const notes = await db
    .select()
    .from(taskNotes)
    .where(and(eq(taskNotes.taskId, taskId), isNull(taskNotes.deletedAt)))
    .orderBy(asc(taskNotes.createdAt));
  const checklist = await db
    .select()
    .from(taskChecklistItems)
    .where(and(eq(taskChecklistItems.taskId, taskId), isNull(taskChecklistItems.deletedAt)))
    .orderBy(asc(taskChecklistItems.position));
  const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(desc(taskEvents.createdAt)).limit(200);
  return {
    task,
    sources: sourceRows.map(({ source, message }) => ({
      id: source.id,
      taskId: source.taskId,
      messageId: message.id,
      accountId: message.accountId,
      role: source.role as "origin" | "update" | "reference",
      addedBy: source.addedBy as "ai" | "user",
      subject: message.subject,
      fromName: message.fromName,
      fromAddress: message.fromAddress,
      sentAt: iso(message.sentAt),
      evidenceQuotes: source.evidenceQuotes,
      attachments: message.attachments.filter((a) => !a.inline).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
      changeSummary: source.changeSummary,
      createdAt: source.createdAt.toISOString(),
    })),
    notes: notes.map(toNoteDto),
    checklist: checklist.map(toChecklistDto),
    events: events.map(toEventDto),
  };
}

async function lockTask(tx: Tx, userId: string, taskId: string) {
  const rows = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .for("update")
    .limit(1);
  if (!rows[0]) throw notFound("Aufgabe");
  return rows[0];
}

async function bumpTask(tx: Tx, userId: string, taskId: string, set: Partial<typeof tasks.$inferInsert> = {}) {
  const [row] = await tx
    .update(tasks)
    .set({ ...set, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
    .where(eq(tasks.id, taskId))
    .returning({ version: tasks.version });
  await recordChange(tx, { userId, entityType: "task", entityId: taskId, op: "upsert", version: row!.version });
  return row!.version;
}

async function ownMessage(tx: Executor, userId: string, messageId: string) {
  const rows = await tx
    .select({ message: messages })
    .from(messages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
    .where(and(eq(messages.id, messageId), eq(mailAccounts.userId, userId)))
    .limit(1);
  if (!rows[0]) throw notFound("Mail");
  return rows[0].message;
}

function deadlineCols(d: ManualDeadline | null | undefined) {
  if (!d) return {};
  return d.precision === "date"
    ? { manualDeadlineDate: d.date, manualDeadlinePrecision: "date" }
    : { manualDeadlineAt: d.dateTime ? new Date(d.dateTime) : null, manualDeadlinePrecision: "datetime" };
}

/** Manual task, optionally with a first note and linked mails, in one transaction. */
export async function createTaskWithExtras(tx: Tx, userId: string, input: TaskCreate): Promise<string> {
  const id = input.id ?? randomUUID();
  const existing = await tx.select({ userId: tasks.userId }).from(tasks).where(eq(tasks.id, id)).limit(1);
  if (existing[0]) {
    if (existing[0].userId !== userId) throw new ApiError(409, "id_conflict", "Diese Kennung ist bereits vergeben");
    return id;
  }
  const sourceIds = input.sourceMessageIds ?? [];
  for (const mid of sourceIds) await ownMessage(tx, userId, mid);
  await tx.insert(tasks).values({
    id,
    userId,
    origin: sourceIds.length > 0 ? "mail_manual" : "manual",
    status: "todo",
    manualTitle: input.title,
    manualNextStep: input.nextStep ?? null,
    manualPriority: input.priority ?? null,
    estimatedMinutes: input.estimatedMinutes ?? null,
    estimateSource: input.estimatedMinutes ? "user" : null,
    ...deadlineCols(input.deadline),
  });
  await recordTaskEvent(tx, { taskId: id, kind: "created_manual", actor: "user", summary: "Von dir angelegt" });
  for (const [i, mid] of sourceIds.entries()) {
    await tx.insert(taskSources).values({ taskId: id, messageId: mid, role: i === 0 ? "origin" : "reference", addedBy: "user" });
  }
  if (input.note) {
    const [note] = await tx.insert(taskNotes).values({ taskId: id, userId, body: input.note }).returning();
    await recordChange(tx, { userId, entityType: "note", entityId: note!.id, op: "upsert", version: note!.version });
  }
  await recordChange(tx, { userId, entityType: "task", entityId: id, op: "upsert", version: 1 });
  return id;
}

export async function linkSource(tx: Tx, userId: string, taskId: string, messageId: string): Promise<void> {
  await lockTask(tx, userId, taskId);
  const message = await ownMessage(tx, userId, messageId);
  const existing = await tx
    .select()
    .from(taskSources)
    .where(and(eq(taskSources.taskId, taskId), eq(taskSources.messageId, messageId)))
    .limit(1);
  if (existing[0] && !existing[0].removedAt) return;
  if (existing[0]) {
    await tx.update(taskSources).set({ removedAt: null }).where(eq(taskSources.id, existing[0].id));
  } else {
    await tx.insert(taskSources).values({ taskId, messageId, role: "reference", addedBy: "user" });
  }
  await recordTaskEvent(tx, {
    taskId,
    kind: "source_added",
    actor: "user",
    messageId,
    summary: `Mail verknüpft: ${message.subject ?? "(ohne Betreff)"}`,
  });
  await bumpTask(tx, userId, taskId);
}

export async function unlinkSource(tx: Tx, userId: string, taskId: string, messageId: string): Promise<void> {
  await lockTask(tx, userId, taskId);
  const updated = await tx
    .update(taskSources)
    .set({ removedAt: new Date() })
    .where(and(eq(taskSources.taskId, taskId), eq(taskSources.messageId, messageId), isNull(taskSources.removedAt)))
    .returning();
  if (updated.length === 0) return;
  await recordTaskEvent(tx, { taskId, kind: "source_removed", actor: "user", messageId, summary: "Mail-Verknüpfung entfernt" });
  await bumpTask(tx, userId, taskId);
}

export async function createTaskFromMessage(
  tx: Tx,
  userId: string,
  messageId: string,
  input: { title?: string | undefined; linkToTaskId?: string | undefined },
): Promise<string> {
  const message = await ownMessage(tx, userId, messageId);
  if (input.linkToTaskId) {
    await linkSource(tx, userId, input.linkToTaskId, messageId);
    return input.linkToTaskId;
  }
  // Two devices taking over the same mail get the same task (the per-user lock serializes this check).
  const [existing] = await tx
    .select({ id: tasks.id })
    .from(taskSources)
    .innerJoin(tasks, eq(tasks.id, taskSources.taskId))
    .where(
      and(
        eq(taskSources.messageId, messageId),
        eq(taskSources.role, "origin"),
        isNull(taskSources.removedAt),
        eq(tasks.origin, "mail_manual"),
        isNull(tasks.deletedAt),
        sql`${tasks.status} <> 'dismissed'`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  return createTaskWithExtras(tx, userId, {
    title: input.title ?? message.subject ?? "Aufgabe aus Mail",
    sourceMessageIds: [messageId],
  });
}

/** Merging keeps every source, note and checklist item and can be undone. */
export async function mergeTasks(tx: Tx, userId: string, sourceTaskId: string, targetTaskId: string): Promise<string> {
  if (sourceTaskId === targetTaskId) throw new ApiError(400, "same_task", "Eine Aufgabe kann nicht mit sich selbst zusammengeführt werden");
  const source = await lockTask(tx, userId, sourceTaskId);
  const target = await lockTask(tx, userId, targetTaskId);
  if (source.mergedIntoTaskId) throw new ApiError(409, "already_merged", "Aufgabe wurde bereits zusammengeführt");
  if (target.mergedIntoTaskId) throw new ApiError(409, "target_merged", "Zielaufgabe wurde selbst zusammengeführt");

  const targetMessages = new Set(
    (await tx.select({ m: taskSources.messageId }).from(taskSources).where(and(eq(taskSources.taskId, targetTaskId), isNull(taskSources.removedAt)))).map((r) => r.m),
  );
  const sourceLinks = await tx.select().from(taskSources).where(and(eq(taskSources.taskId, sourceTaskId), isNull(taskSources.removedAt)));
  const movable = sourceLinks.filter((s) => !targetMessages.has(s.messageId));
  if (movable.length > 0) {
    await tx
      .update(taskSources)
      .set({ taskId: targetTaskId, role: "reference" })
      .where(inArray(taskSources.id, movable.map((s) => s.id)));
  }
  const notes = await tx.update(taskNotes).set({ taskId: targetTaskId, updatedAt: new Date() }).where(eq(taskNotes.taskId, sourceTaskId)).returning();
  const items = await tx
    .update(taskChecklistItems)
    .set({ taskId: targetTaskId, updatedAt: new Date() })
    .where(eq(taskChecklistItems.taskId, sourceTaskId))
    .returning();
  const [merge] = await tx
    .insert(taskMerges)
    .values({
      userId,
      sourceTaskId,
      targetTaskId,
      movedSourceIds: movable.map((s) => s.id),
      movedNoteIds: notes.map((n) => n.id),
      movedChecklistIds: items.map((i) => i.id),
      sourceStatusBefore: source.status,
    })
    .returning();
  const title = source.manualTitle ?? source.aiTitle ?? "Aufgabe";
  await recordTaskEvent(tx, { taskId: targetTaskId, kind: "merged", actor: "user", summary: `Zusammengeführt mit „${title}“`, newValue: { mergeId: merge!.id, sourceTaskId } });
  await recordTaskEvent(tx, { taskId: sourceTaskId, kind: "merged", actor: "user", summary: "In eine andere Aufgabe übernommen", newValue: { mergeId: merge!.id, targetTaskId } });
  await bumpTask(tx, userId, sourceTaskId, { mergedIntoTaskId: targetTaskId });
  await bumpTask(tx, userId, targetTaskId);
  for (const n of notes) await recordChange(tx, { userId, entityType: "note", entityId: n.id, op: "upsert", version: n.version });
  for (const i of items) await recordChange(tx, { userId, entityType: "checklist_item", entityId: i.id, op: "upsert", version: i.version });
  return merge!.id;
}

export async function undoMerge(tx: Tx, userId: string, mergeId: string): Promise<string> {
  const rows = await tx.select().from(taskMerges).where(and(eq(taskMerges.id, mergeId), eq(taskMerges.userId, userId))).for("update").limit(1);
  const merge = rows[0];
  if (!merge) throw notFound("Zusammenführung");
  if (merge.undoneAt) return merge.sourceTaskId;
  await lockTask(tx, userId, merge.sourceTaskId);
  await lockTask(tx, userId, merge.targetTaskId);
  if (merge.movedSourceIds.length) {
    await tx.update(taskSources).set({ taskId: merge.sourceTaskId }).where(inArray(taskSources.id, merge.movedSourceIds));
  }
  const notes = merge.movedNoteIds.length
    ? await tx.update(taskNotes).set({ taskId: merge.sourceTaskId, updatedAt: new Date() }).where(inArray(taskNotes.id, merge.movedNoteIds)).returning()
    : [];
  const items = merge.movedChecklistIds.length
    ? await tx
        .update(taskChecklistItems)
        .set({ taskId: merge.sourceTaskId, updatedAt: new Date() })
        .where(inArray(taskChecklistItems.id, merge.movedChecklistIds))
        .returning()
    : [];
  await tx.update(taskMerges).set({ undoneAt: new Date() }).where(eq(taskMerges.id, mergeId));
  await recordTaskEvent(tx, { taskId: merge.sourceTaskId, kind: "unmerged", actor: "user", summary: "Zusammenführung rückgängig gemacht" });
  await recordTaskEvent(tx, { taskId: merge.targetTaskId, kind: "unmerged", actor: "user", summary: "Zusammenführung rückgängig gemacht" });
  await bumpTask(tx, userId, merge.sourceTaskId, { mergedIntoTaskId: null, status: merge.sourceStatusBefore });
  await bumpTask(tx, userId, merge.targetTaskId);
  for (const n of notes) await recordChange(tx, { userId, entityType: "note", entityId: n.id, op: "upsert", version: n.version });
  for (const i of items) await recordChange(tx, { userId, entityType: "checklist_item", entityId: i.id, op: "upsert", version: i.version });
  return merge.sourceTaskId;
}

/** Corrections change task metadata only; mail contents stay untouched. */
export async function applyCorrection(tx: Tx, userId: string, taskId: string, correction: Correction): Promise<{ taskId: string; mergeId: string | null }> {
  const row = await lockTask(tx, userId, taskId);
  const fake = { idempotencyKey: randomUUID(), type: "task.update" as const, entityId: taskId, baseVersion: row.version, payload: {} };
  switch (correction.kind) {
    case "not_a_task":
      await updateTask(tx, userId, fake, row.version, { status: "dismissed" });
      await tx.update(tasks).set({ dismissedReason: "not_a_task" }).where(eq(tasks.id, taskId));
      await recordTaskEvent(tx, { taskId, kind: "correction", actor: "user", summary: "Korrektur: keine Aufgabe" });
      return { taskId, mergeId: null };
    case "wrong_priority":
      await updateTask(tx, userId, fake, row.version, { priority: correction.priority });
      await recordTaskEvent(tx, { taskId, kind: "correction", actor: "user", summary: "Korrektur: falsche Priorität", oldValue: row.aiPriority, newValue: correction.priority });
      return { taskId, mergeId: null };
    case "wrong_deadline":
      await updateTask(
        tx,
        userId,
        fake,
        row.version,
        correction.deadline ? { deadline: correction.deadline } : { deadlineCleared: true },
      );
      await recordTaskEvent(tx, { taskId, kind: "correction", actor: "user", summary: "Korrektur: Frist falsch erkannt", newValue: correction.deadline });
      return { taskId, mergeId: null };
    case "belongs_to": {
      const mergeId = await mergeTasks(tx, userId, taskId, correction.taskId);
      await recordTaskEvent(tx, { taskId: correction.taskId, kind: "correction", actor: "user", summary: "Korrektur: gehört zu dieser Aufgabe" });
      return { taskId: correction.taskId, mergeId };
    }
  }
}

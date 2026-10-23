import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  Jobs,
  type ManualDeadline,
  type Mutation,
  type MutationResult,
  type SyncEntityType,
  type TaskPatch,
} from "@mailpilot/contracts";
import {
  recordChange,
  recordTaskEvent,
  schema,
  type Database,
  type FieldVersions,
  type Tx,
} from "@mailpilot/database";
import type { JobQueue } from "../queue.js";
import { ApiError } from "../errors.js";
import { iso } from "./dto.js";
import { withIdempotency } from "./idempotency.js";

const { tasks, taskNotes, taskChecklistItems, clarificationRequests, userRules } = schema;

type TaskRow = typeof tasks.$inferSelect;

interface Outcome {
  result: MutationResult;
  afterCommit: Array<() => Promise<void>>;
}

const entityTypeOf = (m: Mutation): SyncEntityType =>
  m.type.startsWith("task.") ? "task" : m.type.startsWith("note.") ? "note" : m.type.startsWith("checklist.") ? "checklist_item" : "clarification";

const result = (
  m: Mutation,
  status: MutationResult["status"],
  extra: Partial<Omit<MutationResult, "idempotencyKey" | "status" | "entityType" | "entityId">> = {},
): MutationResult => ({
  idempotencyKey: m.idempotencyKey,
  status,
  entityType: entityTypeOf(m),
  entityId: m.entityId,
  version: extra.version ?? null,
  conflictingFields: extra.conflictingFields ?? [],
  createdEntityId: extra.createdEntityId ?? null,
  error: extra.error ?? null,
});

const rejected = (m: Mutation, code: string, message: string) => result(m, "rejected", { error: { code, message } });

/**
 * Applies one client mutation exactly once. A replay with the same idempotency key returns the
 * stored result; reusing a key for a different request is rejected.
 */
export async function applyMutation(db: Database, queue: JobQueue, userId: string, mutation: Mutation): Promise<MutationResult> {
  const { idempotencyKey: _k, clientTimestamp: _t, ...request } = mutation;
  try {
    return await withIdempotency(db, userId, mutation.idempotencyKey, request, async (tx) => {
      const outcome = await dispatch(tx, userId, mutation, queue);
      return { response: outcome.result, afterCommit: outcome.afterCommit };
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "idempotency_key_reused") {
      return rejected(mutation, error.code, error.message);
    }
    throw error;
  }
}

async function dispatch(tx: Tx, userId: string, m: Mutation, queue: JobQueue): Promise<Outcome> {
  switch (m.type) {
    case "task.create":
      return { result: await createTask(tx, userId, m), afterCommit: [] };
    case "task.update":
      return { result: await updateTask(tx, userId, m, m.baseVersion, m.payload), afterCommit: [] };
    case "task.dismiss":
      return { result: await updateTask(tx, userId, m, m.baseVersion, { status: "dismissed" }), afterCommit: [] };
    case "task.restore":
      return { result: await restoreTask(tx, userId, m), afterCommit: [] };
    case "note.create":
      return { result: await createNote(tx, userId, m), afterCommit: [] };
    case "note.update":
      return { result: await updateNote(tx, userId, m), afterCommit: [] };
    case "note.delete":
      return { result: await deleteNote(tx, userId, m), afterCommit: [] };
    case "checklist.create":
      return { result: await createChecklistItem(tx, userId, m), afterCommit: [] };
    case "checklist.update":
      return { result: await updateChecklistItem(tx, userId, m), afterCommit: [] };
    case "checklist.delete":
      return { result: await deleteChecklistItem(tx, userId, m), afterCommit: [] };
    case "clarification.answer":
      return answerClarification(tx, userId, m, queue);
  }
}

// ---------------------------------------------------------------- tasks

function manualDeadlineColumns(d: ManualDeadline | null) {
  if (!d) return { manualDeadlineDate: null, manualDeadlineAt: null, manualDeadlinePrecision: null };
  return d.precision === "date"
    ? { manualDeadlineDate: d.date, manualDeadlineAt: null, manualDeadlinePrecision: "date" }
    : { manualDeadlineDate: null, manualDeadlineAt: d.dateTime ? new Date(d.dateTime) : null, manualDeadlinePrecision: "datetime" };
}

async function createTask(tx: Tx, userId: string, m: Extract<Mutation, { type: "task.create" }>): Promise<MutationResult> {
  const existing = await tx.select({ userId: tasks.userId, version: tasks.version }).from(tasks).where(eq(tasks.id, m.entityId)).limit(1);
  if (existing[0]) {
    return existing[0].userId === userId
      ? result(m, "duplicate", { version: existing[0].version })
      : rejected(m, "id_conflict", "Diese Kennung ist bereits vergeben");
  }
  const p = m.payload;
  const [row] = await tx
    .insert(tasks)
    .values({
      id: m.entityId,
      userId,
      origin: "manual",
      status: "todo",
      manualTitle: p.title,
      manualNextStep: p.nextStep ?? null,
      manualPriority: p.priority ?? null,
      aiPriority: null,
      ...manualDeadlineColumns(p.deadline ?? null),
    })
    .returning();
  await recordTaskEvent(tx, { taskId: row!.id, kind: "created_manual", actor: "user", summary: "Von dir angelegt" });
  await recordChange(tx, { userId, entityType: "task", entityId: row!.id, op: "upsert", version: row!.version });
  return result(m, "applied", { version: row!.version });
}

type FieldKey =
  | "status"
  | "waiting"
  | "waitingCheckAt"
  | "snoozedUntil"
  | "plannedFor"
  | "sortKey"
  | "title"
  | "nextStep"
  | "priority"
  | "deadline"
  | "estimatedMinutes";

const sameInstant = (a: Date | null, b: string | null | undefined) =>
  (a === null && (b === null || b === undefined)) || (a !== null && b != null && a.getTime() === new Date(b).getTime());

/** Field-level merge: a field is applied unless the server changed it after the client's baseVersion. */
export async function updateTask(tx: Tx, userId: string, m: Mutation, baseVersion: number, patch: TaskPatch): Promise<MutationResult> {
  const rows = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, m.entityId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) return rejected(m, "not_found", "Aufgabe nicht gefunden");
  if (row.mergedIntoTaskId) return rejected(m, "merged", "Aufgabe wurde mit einer anderen zusammengeführt");

  const fv: FieldVersions = { ...row.fieldVersions };
  const newVersion = row.version + 1;
  const set: Partial<TaskRow> = {};
  const applied: FieldKey[] = [];
  const conflicts: FieldKey[] = [];
  const events: Array<Parameters<typeof recordTaskEvent>[1]> = [];

  const consider = (key: FieldKey, unchanged: boolean, apply: () => void) => {
    if (unchanged) return;
    if ((fv[key] ?? 0) > baseVersion) {
      conflicts.push(key);
      return;
    }
    apply();
    fv[key] = newVersion;
    applied.push(key);
  };

  if (patch.status !== undefined) {
    const to = patch.status;
    consider("status", row.status === to, () => {
      set.status = to;
      if (to === "done") set.doneAt = new Date();
      if (row.status === "done" && to !== "done") set.doneAt = null;
      if (to === "dismissed") {
        set.dismissedAt = new Date();
        set.statusBeforeDismiss = row.status;
      }
      if (row.status === "dismissed" && to !== "dismissed") set.dismissedAt = null;
      events.push({
        taskId: row.id,
        kind: to === "dismissed" ? "dismissed" : "status_changed",
        actor: "user",
        summary: to === "dismissed" ? "Als nicht relevant markiert" : `Status: ${statusLabel(row.status)} → ${statusLabel(to)}`,
        oldValue: row.status,
        newValue: to,
      });
    });
  }
  if (patch.waiting !== undefined) {
    consider("waiting", row.waiting === patch.waiting, () => {
      set.waiting = patch.waiting!;
      events.push({
        taskId: row.id,
        kind: "waiting_changed",
        actor: "user",
        summary: patch.waiting ? "Warte auf Antwort" : "Warten beendet",
        oldValue: row.waiting,
        newValue: patch.waiting,
      });
    });
  }
  if (patch.waitingCheckAt !== undefined) {
    consider("waitingCheckAt", row.waitingCheckAt === patch.waitingCheckAt, () => {
      set.waitingCheckAt = patch.waitingCheckAt ?? null;
    });
  }
  if (patch.snoozedUntil !== undefined) {
    consider("snoozedUntil", sameInstant(row.snoozedUntil, patch.snoozedUntil), () => {
      set.snoozedUntil = patch.snoozedUntil ? new Date(patch.snoozedUntil) : null;
      events.push({
        taskId: row.id,
        kind: "snoozed",
        actor: "user",
        summary: patch.snoozedUntil ? "Später anzeigen" : "Wieder sichtbar",
        newValue: patch.snoozedUntil ?? null,
      });
    });
  }
  if (patch.plannedFor !== undefined) {
    consider("plannedFor", row.plannedFor === patch.plannedFor, () => {
      set.plannedFor = patch.plannedFor ?? null;
    });
  }
  if (patch.sortKey !== undefined) {
    consider("sortKey", row.sortKey === patch.sortKey, () => {
      set.sortKey = patch.sortKey ?? null;
    });
  }
  if (patch.title !== undefined) {
    consider("title", row.manualTitle === patch.title, () => {
      set.manualTitle = patch.title ?? null;
      events.push({
        taskId: row.id,
        kind: "title_changed",
        actor: "user",
        summary: patch.title ? "Titel von dir geändert" : "Titel zurück auf Vorschlag",
        oldValue: row.manualTitle ?? row.aiTitle,
        newValue: patch.title ?? row.aiTitle,
      });
    });
  }
  if (patch.nextStep !== undefined) {
    consider("nextStep", row.manualNextStep === patch.nextStep, () => {
      set.manualNextStep = patch.nextStep ?? null;
    });
  }
  if (patch.priority !== undefined) {
    consider("priority", row.manualPriority === patch.priority, () => {
      set.manualPriority = patch.priority ?? null;
      events.push({
        taskId: row.id,
        kind: "priority_changed",
        actor: "user",
        summary: patch.priority ? `Priorität manuell: ${priorityLabel(patch.priority)}` : "Priorität zurück auf Vorschlag",
        oldValue: row.manualPriority ?? row.aiPriority,
        newValue: patch.priority ?? row.aiPriority,
      });
    });
  }
  if (patch.deadline !== undefined || patch.deadlineCleared !== undefined) {
    // deadlineCleared=true: "keine Frist" override. deadline=null: back to the AI deadline.
    const target =
      patch.deadlineCleared === true
        ? { ...manualDeadlineColumns(null), manualDeadlineCleared: true }
        : patch.deadline !== undefined
          ? { ...manualDeadlineColumns(patch.deadline), manualDeadlineCleared: false }
          : {
              manualDeadlineDate: row.manualDeadlineDate,
              manualDeadlineAt: row.manualDeadlineAt,
              manualDeadlinePrecision: row.manualDeadlinePrecision,
              manualDeadlineCleared: false,
            };
    const unchanged =
      target.manualDeadlineDate === row.manualDeadlineDate &&
      target.manualDeadlinePrecision === row.manualDeadlinePrecision &&
      sameInstant(row.manualDeadlineAt, target.manualDeadlineAt?.toISOString() ?? null) &&
      target.manualDeadlineCleared === row.manualDeadlineCleared;
    consider("deadline", unchanged, () => {
      Object.assign(set, target);
      events.push({
        taskId: row.id,
        kind: "deadline_changed",
        actor: "user",
        summary: target.manualDeadlineCleared
          ? "Frist von dir entfernt"
          : patch.deadline
            ? `Frist von dir gesetzt: ${patch.deadline.date ?? patch.deadline.dateTime}`
            : "Frist zurück auf Vorschlag",
        oldValue: row.manualDeadlineDate ?? iso(row.manualDeadlineAt) ?? row.aiDeadlineDate ?? iso(row.aiDeadlineAt),
        newValue: patch.deadline ?? null,
      });
    });
  }
  if (patch.estimatedMinutes !== undefined) {
    consider("estimatedMinutes", row.estimatedMinutes === patch.estimatedMinutes, () => {
      set.estimatedMinutes = patch.estimatedMinutes ?? null;
      set.estimateSource = patch.estimatedMinutes ? "user" : null;
    });
  }

  if (applied.length === 0) {
    return conflicts.length > 0
      ? result(m, "conflict", { version: row.version, conflictingFields: conflicts })
      : result(m, "applied", { version: row.version });
  }
  await tx
    .update(tasks)
    .set({ ...set, fieldVersions: fv, version: newVersion, updatedAt: new Date() })
    .where(eq(tasks.id, row.id));
  for (const e of events) await recordTaskEvent(tx, e);
  await recordChange(tx, { userId, entityType: "task", entityId: row.id, op: "upsert", version: newVersion });
  return result(m, conflicts.length > 0 ? "conflict" : "applied", { version: newVersion, conflictingFields: conflicts });
}

async function restoreTask(tx: Tx, userId: string, m: Extract<Mutation, { type: "task.restore" }>): Promise<MutationResult> {
  const rows = await tx.select().from(tasks).where(and(eq(tasks.id, m.entityId), eq(tasks.userId, userId))).limit(1);
  const row = rows[0];
  if (!row) return rejected(m, "not_found", "Aufgabe nicht gefunden");
  if (row.status !== "dismissed") return result(m, "applied", { version: row.version });
  const to = (row.statusBeforeDismiss as TaskPatch["status"]) ?? "todo";
  const r = await updateTask(tx, userId, m, m.baseVersion, { status: to === "dismissed" ? "todo" : to });
  if (r.status === "applied") {
    await recordTaskEvent(tx, { taskId: row.id, kind: "restored", actor: "user", summary: "Wiederhergestellt" });
  }
  return r;
}

// ---------------------------------------------------------------- notes

async function ownTask(tx: Tx, userId: string, taskId: string) {
  const rows = await tx
    .select({ id: tasks.id, version: tasks.version })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

async function createNote(tx: Tx, userId: string, m: Extract<Mutation, { type: "note.create" }>): Promise<MutationResult> {
  const existing = await tx.select({ userId: taskNotes.userId, version: taskNotes.version }).from(taskNotes).where(eq(taskNotes.id, m.entityId)).limit(1);
  if (existing[0]) {
    return existing[0].userId === userId
      ? result(m, "duplicate", { version: existing[0].version })
      : rejected(m, "id_conflict", "Diese Kennung ist bereits vergeben");
  }
  if (!(await ownTask(tx, userId, m.payload.taskId))) return rejected(m, "not_found", "Aufgabe nicht gefunden");
  const [row] = await tx.insert(taskNotes).values({ id: m.entityId, taskId: m.payload.taskId, userId, body: m.payload.body }).returning();
  await recordTaskEvent(tx, { taskId: m.payload.taskId, kind: "note_added", actor: "user", summary: "Notiz ergänzt" });
  await recordChange(tx, { userId, entityType: "note", entityId: row!.id, op: "upsert", version: row!.version });
  return result(m, "applied", { version: row!.version });
}

/** A stale edit never overwrites: it is kept as a separate note linked to the original. */
async function updateNote(tx: Tx, userId: string, m: Extract<Mutation, { type: "note.update" }>): Promise<MutationResult> {
  const rows = await tx.select().from(taskNotes).where(and(eq(taskNotes.id, m.entityId), eq(taskNotes.userId, userId))).for("update").limit(1);
  const note = rows[0];
  if (!note) return rejected(m, "not_found", "Notiz nicht gefunden");
  if (note.body === m.payload.body && !note.deletedAt) return result(m, "applied", { version: note.version });
  if (note.version === m.baseVersion && !note.deletedAt) {
    const version = note.version + 1;
    await tx.update(taskNotes).set({ body: m.payload.body, version, updatedAt: new Date() }).where(eq(taskNotes.id, note.id));
    await recordChange(tx, { userId, entityType: "note", entityId: note.id, op: "upsert", version });
    return result(m, "applied", { version });
  }
  const copyId = randomUUID();
  const [copy] = await tx
    .insert(taskNotes)
    .values({ id: copyId, taskId: note.taskId, userId, body: m.payload.body, conflictOfNoteId: note.id })
    .returning();
  await recordTaskEvent(tx, {
    taskId: note.taskId,
    kind: "note_conflict",
    actor: "system",
    summary: "Gleichzeitig bearbeitete Notiz: beide Fassungen behalten",
  });
  await recordChange(tx, { userId, entityType: "note", entityId: copy!.id, op: "upsert", version: copy!.version });
  return result(m, "conflict", { version: note.version, createdEntityId: copy!.id });
}

async function deleteNote(tx: Tx, userId: string, m: Extract<Mutation, { type: "note.delete" }>): Promise<MutationResult> {
  const rows = await tx.select().from(taskNotes).where(and(eq(taskNotes.id, m.entityId), eq(taskNotes.userId, userId))).for("update").limit(1);
  const note = rows[0];
  if (!note || note.deletedAt) return result(m, "applied", { version: note?.version ?? null });
  if (note.version !== m.baseVersion) {
    return result(m, "conflict", { version: note.version, conflictingFields: ["body"] });
  }
  const version = note.version + 1;
  await tx.update(taskNotes).set({ deletedAt: new Date(), version, updatedAt: new Date() }).where(eq(taskNotes.id, note.id));
  await recordChange(tx, { userId, entityType: "note", entityId: note.id, op: "delete", version });
  return result(m, "applied", { version });
}

// ---------------------------------------------------------------- checklist

async function createChecklistItem(tx: Tx, userId: string, m: Extract<Mutation, { type: "checklist.create" }>): Promise<MutationResult> {
  const existing = await tx.select({ version: taskChecklistItems.version }).from(taskChecklistItems).where(eq(taskChecklistItems.id, m.entityId)).limit(1);
  if (existing[0]) return result(m, "duplicate", { version: existing[0].version });
  if (!(await ownTask(tx, userId, m.payload.taskId))) return rejected(m, "not_found", "Aufgabe nicht gefunden");
  const position =
    m.payload.position ??
    Number(
      (
        await tx
          .select({ max: sql<number | null>`max(${taskChecklistItems.position})` })
          .from(taskChecklistItems)
          .where(eq(taskChecklistItems.taskId, m.payload.taskId))
      )[0]?.max ?? 0,
    ) + 1;
  const [row] = await tx
    .insert(taskChecklistItems)
    .values({ id: m.entityId, taskId: m.payload.taskId, title: m.payload.title, position, source: "user" })
    .returning();
  await recordChange(tx, { userId, entityType: "checklist_item", entityId: row!.id, op: "upsert", version: row!.version });
  return result(m, "applied", { version: row!.version });
}

async function checklistRow(tx: Tx, userId: string, id: string) {
  const rows = await tx
    .select({ item: taskChecklistItems })
    .from(taskChecklistItems)
    .innerJoin(tasks, eq(tasks.id, taskChecklistItems.taskId))
    .where(and(eq(taskChecklistItems.id, id), eq(tasks.userId, userId)))
    .limit(1);
  return rows[0]?.item ?? null;
}

async function updateChecklistItem(tx: Tx, userId: string, m: Extract<Mutation, { type: "checklist.update" }>): Promise<MutationResult> {
  const item = await checklistRow(tx, userId, m.entityId);
  if (!item || item.deletedAt) return rejected(m, "not_found", "Eintrag nicht gefunden");
  const p = m.payload;
  const unchanged =
    (p.title === undefined || p.title === item.title) &&
    (p.done === undefined || p.done === item.done) &&
    (p.position === undefined || p.position === item.position);
  if (unchanged) return result(m, "applied", { version: item.version });
  // Ticking a box is safe to merge; other edits require the current version.
  const onlyDone = p.title === undefined && p.position === undefined;
  if (item.version !== m.baseVersion && !onlyDone) {
    return result(m, "conflict", { version: item.version, conflictingFields: Object.keys(p) });
  }
  const version = item.version + 1;
  await tx
    .update(taskChecklistItems)
    .set({ ...p, version, updatedAt: new Date() })
    .where(eq(taskChecklistItems.id, item.id));
  await recordChange(tx, { userId, entityType: "checklist_item", entityId: item.id, op: "upsert", version });
  return result(m, "applied", { version });
}

async function deleteChecklistItem(tx: Tx, userId: string, m: Extract<Mutation, { type: "checklist.delete" }>): Promise<MutationResult> {
  const item = await checklistRow(tx, userId, m.entityId);
  if (!item || item.deletedAt) return result(m, "applied", { version: item?.version ?? null });
  const version = item.version + 1;
  await tx.update(taskChecklistItems).set({ deletedAt: new Date(), version, updatedAt: new Date() }).where(eq(taskChecklistItems.id, item.id));
  await recordChange(tx, { userId, entityType: "checklist_item", entityId: item.id, op: "delete", version });
  return result(m, "applied", { version });
}

// ---------------------------------------------------------------- clarifications

const ruleKindFor = (kind: string): "membership" | "responsibility" | "sender_relevance" | null =>
  kind === "membership" ? "membership" : kind === "responsibility" ? "responsibility" : kind === "relevance" ? "sender_relevance" : null;

async function answerClarification(
  tx: Tx,
  userId: string,
  m: Extract<Mutation, { type: "clarification.answer" }>,
  queue: JobQueue,
): Promise<Outcome> {
  const rows = await tx
    .select()
    .from(clarificationRequests)
    .where(and(eq(clarificationRequests.id, m.entityId), eq(clarificationRequests.userId, userId)))
    .for("update")
    .limit(1);
  const c = rows[0];
  if (!c) return { result: rejected(m, "not_found", "Rückfrage nicht gefunden"), afterCommit: [] };
  const p = m.payload;
  if (c.status !== "open") {
    const same = c.answerOptionId === (p.optionId ?? null) && c.answerText === (p.text ?? null);
    return { result: same ? result(m, "applied", { version: c.version }) : result(m, "conflict", { version: c.version, conflictingFields: ["answer"] }), afterCommit: [] };
  }
  const option = p.optionId ? c.options.find((o) => o.id === p.optionId) : undefined;
  if (p.optionId && !option) return { result: rejected(m, "invalid_option", "Unbekannte Antwortmöglichkeit"), afterCommit: [] };
  if (!p.optionId && !p.text) return { result: rejected(m, "empty_answer", "Antwort fehlt"), afterCommit: [] };
  if (!p.optionId && !c.allowFreeText) return { result: rejected(m, "free_text_not_allowed", "Freie Antwort nicht vorgesehen"), afterCommit: [] };

  // A one-off answer ("Diesmal nicht") never becomes a rule; only an explicit permanent answer does.
  const scope = p.scope === "permanent" && (option ? option.scope === "permanent" : true) ? "permanent" : "once";
  // "Weiß ich noch nicht" keeps the question open (deferred) and triggers nothing.
  const deferred = option?.id === "later";
  const version = c.version + 1;
  await tx
    .update(clarificationRequests)
    .set({
      status: deferred ? "open" : "answered",
      answerOptionId: p.optionId ?? null,
      answerText: p.text ?? null,
      answerScope: scope,
      answeredAt: new Date(),
      version,
      updatedAt: new Date(),
    })
    .where(eq(clarificationRequests.id, c.id));
  await recordChange(tx, { userId, entityType: "clarification", entityId: c.id, op: "upsert", version });

  const ruleKind = ruleKindFor(c.kind);
  if (scope === "permanent" && ruleKind && c.subject && option && (option.id === "yes" || option.id === "no")) {
    const applies = option.id === "yes";
    const existing = await tx
      .select()
      .from(userRules)
      .where(and(eq(userRules.userId, userId), eq(userRules.kind, ruleKind), sql`lower(${userRules.subject}) = lower(${c.subject})`, isNull(userRules.deletedAt)))
      .limit(1);
    if (existing[0]) {
      const v = existing[0].version + 1;
      await tx.update(userRules).set({ applies, version: v, updatedAt: new Date(), sourceClarificationId: c.id }).where(eq(userRules.id, existing[0].id));
      await recordChange(tx, { userId, entityType: "rule", entityId: existing[0].id, op: "upsert", version: v });
    } else {
      const [rule] = await tx
        .insert(userRules)
        .values({ userId, kind: ruleKind, subject: c.subject, applies, sourceClarificationId: c.id })
        .returning();
      await recordChange(tx, { userId, entityType: "rule", entityId: rule!.id, op: "upsert", version: rule!.version });
    }
  }
  return {
    result: result(m, "applied", { version }),
    afterCommit: deferred ? [] : [async () => queue.add(Jobs.applyClarification, { clarificationId: c.id }, { jobKey: `clar:${c.id}` })],
  };
}

const statusLabel = (s: string) => ({ todo: "To Do", doing: "Doing", done: "Erledigt", dismissed: "Nicht relevant" })[s] ?? s;
const priorityLabel = (p: string) => ({ critical: "Kritisch", important: "Wichtig", can_wait: "Kann warten" })[p] ?? p;

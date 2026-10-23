import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { AnalysisAction, AnalysisClarification, AnalysisOutput } from "@mailpilot/contracts";
import { recordChange, recordTaskEvent, schema, type Executor, type Tx } from "@mailpilot/database";
import type { AccountRow, MessageRow, TaskRow } from "./deps.js";

const { tasks, taskSources, taskChecklistItems, clarificationRequests, markerOperations, messages } = schema;

/** Clarification kinds that hold back the related action(s) until the user answers. */
export const HOLDING_KINDS = new Set(["relevance", "membership", "responsibility"]);

export interface ApplyContext {
  userId: string;
  account: AccountRow;
  message: MessageRow;
  analysisId: string;
  output: AnalysisOutput;
}

export interface ApplyOutcome {
  created: string[];
  updated: string[];
  clarifications: string[];
  markerOperations: string[];
  skipped: number;
}

export const actionKeyOf = (title: string) =>
  createHash("sha256")
    .update(title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim())
    .digest("hex")
    .slice(0, 24);

/** Indices of actions that wait for an answer; a null index on a holding question means all actions. */
export function heldActionIndices(output: AnalysisOutput): Set<number> {
  const held = new Set<number>();
  for (const c of output.clarifications) {
    if (HOLDING_KINDS.has(c.kind)) {
      if (c.related_action_index === null) output.actions.forEach((_, i) => held.add(i));
      else held.add(c.related_action_index);
    } else if (c.kind === "merge" && c.related_action_index !== null) held.add(c.related_action_index);
  }
  return held;
}

export async function applyAnalysis(tx: Tx, ctx: ApplyContext): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { created: [], updated: [], clarifications: [], markerOperations: [], skipped: 0 };
  const held = heldActionIndices(ctx.output);
  for (const [i, action] of ctx.output.actions.entries()) {
    if (held.has(i)) continue;
    await applyAction(tx, ctx, action, outcome);
  }
  for (const [i, c] of ctx.output.clarifications.entries()) {
    const id = await insertClarification(tx, ctx, c, i);
    if (id) outcome.clarifications.push(id);
  }
  return outcome;
}

/** Creates or updates the task for one action. Idempotent per (message, action). */
export async function applyAction(tx: Tx, ctx: ApplyContext, action: AnalysisAction, outcome: ApplyOutcome, forceNew = false): Promise<void> {
  const actionKey = actionKeyOf(action.action_title_de);
  let target: TaskRow | null = null;
  if (!forceNew && action.suggested_existing_task_id) target = await lockTask(tx, ctx.userId, action.suggested_existing_task_id);
  if (!target) {
    const [origin] = await tx
      .select({ taskId: taskSources.taskId })
      .from(taskSources)
      .where(and(eq(taskSources.messageId, ctx.message.id), eq(taskSources.actionKey, actionKey), eq(taskSources.role, "origin")))
      .limit(1);
    if (origin) target = await lockTask(tx, ctx.userId, origin.taskId);
  }
  if (target?.mergedIntoTaskId) target = await lockTask(tx, ctx.userId, target.mergedIntoTaskId);

  if (!target) {
    await createAiTask(tx, ctx, action, actionKey, outcome, null);
    return;
  }
  const [link] = await tx.select({ id: taskSources.id }).from(taskSources).where(and(eq(taskSources.taskId, target.id), eq(taskSources.messageId, ctx.message.id))).limit(1);
  const newMessage = !link;

  if (target.status === "dismissed") {
    if (!newMessage) {
      // Same mail analyzed again: a dismissed task is not created again.
      outcome.skipped++;
      return;
    }
    await linkSource(tx, target.id, ctx.message.id, "update", action);
    await recordTaskEvent(tx, {
      taskId: target.id,
      kind: "source_added",
      actor: "ai",
      messageId: ctx.message.id,
      summary: `Neue Mail zu dieser verworfenen Aufgabe: „${ctx.message.subject ?? "ohne Betreff"}“`,
    });
    await bump(tx, ctx.userId, target.id, { latestChange: action.update_summary_de ?? "Neue Mail zu einer verworfenen Aufgabe" });
    const id = await upsertClarification(tx, ctx, {
      kind: "reopen",
      question: `Neue Information zu „${titleOf(target)}“. Wieder aufnehmen?`,
      reason: "Du hattest die Aufgabe als nicht relevant markiert; jetzt ist eine neue Mail dazu eingetroffen.",
      excerpt: action.evidence_quotes[0] ?? null,
      subject: null,
      options: [
        { id: "reopen", label: "Wieder aufnehmen", scope: "once" },
        { id: "keep", label: "Verworfen lassen", scope: "once" },
        { id: "later", label: "Später entscheiden", scope: "once" },
      ],
      dedupeKey: `reopen:${target.id}:${ctx.message.id}`,
      taskId: target.id,
      actionIndex: null,
    });
    if (id) outcome.clarifications.push(id);
    return;
  }

  if (target.status === "done" && newMessage) {
    // A new obligation in a finished thread becomes its own task; the finished one stays finished.
    await createAiTask(tx, ctx, action, actionKey, outcome, target);
    await recordTaskEvent(tx, {
      taskId: target.id,
      kind: "follow_up_created",
      actor: "ai",
      messageId: ctx.message.id,
      summary: `Neue Mail im Thread – Folgeaufgabe „${action.action_title_de}“ angelegt`,
    });
    await bump(tx, ctx.userId, target.id);
    return;
  }

  await updateAiFields(tx, ctx, target, action, newMessage);
  outcome.updated.push(target.id);
}

async function lockTask(tx: Tx, userId: string, id: string): Promise<TaskRow | null> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .for("update")
    .limit(1);
  return row ?? null;
}

const titleOf = (t: TaskRow) => t.manualTitle ?? t.aiTitle ?? "Aufgabe";

function aiDeadlineColumns(a: AnalysisAction) {
  if (!a.deadline || a.deadline_precision === "none") {
    return { aiDeadlineDate: null, aiDeadlineAt: null, aiDeadlinePrecision: null, aiDeadlineKind: null, aiDeadlineQuote: null };
  }
  return a.deadline_precision === "date"
    ? { aiDeadlineDate: a.deadline.slice(0, 10), aiDeadlineAt: null, aiDeadlinePrecision: "date", aiDeadlineKind: a.deadline_kind, aiDeadlineQuote: a.deadline_source_quote }
    : { aiDeadlineDate: null, aiDeadlineAt: new Date(a.deadline), aiDeadlinePrecision: "datetime", aiDeadlineKind: a.deadline_kind, aiDeadlineQuote: a.deadline_source_quote };
}

const deadlineLabel = (date: string | null, at: Date | null) => date ?? (at ? at.toISOString() : null);

async function bump(tx: Tx, userId: string, taskId: string, set: Partial<typeof tasks.$inferInsert> = {}) {
  const [row] = await tx
    .update(tasks)
    .set({ ...set, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .returning({ version: tasks.version });
  await recordChange(tx, { userId, entityType: "task", entityId: taskId, op: "upsert", version: row!.version });
}

async function linkSource(tx: Tx, taskId: string, messageId: string, role: "origin" | "update" | "reference", action: AnalysisAction, actionKey: string | null = null) {
  await tx
    .insert(taskSources)
    .values({
      taskId,
      messageId,
      role,
      addedBy: "ai",
      actionKey: role === "origin" ? actionKey : null,
      evidenceQuotes: action.evidence_quotes,
      changeSummary: action.update_summary_de,
    })
    .onConflictDoNothing({ target: [taskSources.taskId, taskSources.messageId] });
}

async function createAiTask(tx: Tx, ctx: ApplyContext, action: AnalysisAction, actionKey: string, outcome: ApplyOutcome, followUpOf: TaskRow | null) {
  const [task] = await tx
    .insert(tasks)
    .values({
      userId: ctx.userId,
      origin: "ai",
      status: "todo",
      aiTitle: action.action_title_de,
      aiNextStep: action.next_step_de,
      aiSummary: ctx.output.summary_de,
      aiPriority: action.priority,
      aiPriorityReason: action.priority_reason_de,
      ...aiDeadlineColumns(action),
      aiWhy: followUpOf ? `${action.why_de} Folgeaufgabe zu „${titleOf(followUpOf)}“.` : action.why_de,
      aiNeeds: action.needs_de,
      requiresAttachmentReading: action.requires_attachment_reading,
    })
    .returning();
  // The partial unique index on (message, action key) makes a duplicate creation fail and roll back.
  const inserted = await tx
    .insert(taskSources)
    .values({
      taskId: task!.id,
      messageId: ctx.message.id,
      role: "origin",
      addedBy: "ai",
      actionKey,
      evidenceQuotes: action.evidence_quotes,
      changeSummary: null,
    })
    .onConflictDoNothing()
    .returning({ id: taskSources.id });
  if (inserted.length === 0) throw new Error(`task for message ${ctx.message.id} / ${actionKey} already exists`);
  for (const id of action.source_message_ids) {
    if (id === ctx.message.id) continue;
    const [m] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.id, id)).limit(1);
    if (m) await linkSource(tx, task!.id, id, "reference", action);
  }
  if (action.checklist_de.length >= 2) {
    const items = await tx
      .insert(taskChecklistItems)
      .values(action.checklist_de.map((title, i) => ({ taskId: task!.id, title, position: i + 1, source: "ai" })))
      .returning();
    for (const item of items) await recordChange(tx, { userId: ctx.userId, entityType: "checklist_item", entityId: item.id, op: "upsert", version: item.version });
  }
  await recordTaskEvent(tx, {
    taskId: task!.id,
    kind: "created_auto",
    actor: "ai",
    messageId: ctx.message.id,
    summary: `Automatisch angelegt aus der Mail „${ctx.message.subject ?? "ohne Betreff"}“${ctx.message.fromName || ctx.message.fromAddress ? ` von ${ctx.message.fromName ?? ctx.message.fromAddress}` : ""}`,
  });
  await recordChange(tx, { userId: ctx.userId, entityType: "task", entityId: task!.id, op: "upsert", version: task!.version });
  outcome.created.push(task!.id);
  const op = await queueMarker(tx, ctx, task!.id);
  if (op) outcome.markerOperations.push(op);
}

/** AI values are refreshed; manual title, priority, deadline, notes and status are never touched. */
async function updateAiFields(tx: Tx, ctx: ApplyContext, target: TaskRow, action: AnalysisAction, newMessage: boolean) {
  const next = aiDeadlineColumns(action);
  const before = deadlineLabel(target.aiDeadlineDate, target.aiDeadlineAt);
  const after = deadlineLabel(next.aiDeadlineDate, next.aiDeadlineAt);
  const deadlineChanged = before !== after && after !== null;
  const priorityChanged = target.aiPriority !== action.priority;
  let latestChange = target.latestChange;

  if (deadlineChanged) {
    const summary = action.update_summary_de ?? `Frist laut Mail: ${before ?? "keine"} → ${after}`;
    latestChange = summary;
    await recordTaskEvent(tx, {
      taskId: target.id,
      kind: "deadline_changed",
      actor: "ai",
      messageId: ctx.message.id,
      summary: target.manualDeadlinePrecision || target.manualDeadlineCleared ? `${summary} (deine manuelle Frist bleibt bestehen)` : summary,
      oldValue: before,
      newValue: after,
    });
  }
  if (priorityChanged) {
    await recordTaskEvent(tx, {
      taskId: target.id,
      kind: "priority_changed",
      actor: "ai",
      messageId: ctx.message.id,
      summary: target.manualPriority ? "Vorschlag geändert; deine manuelle Priorität bleibt bestehen" : `Priorität neu eingeschätzt: ${action.priority_reason_de}`,
      oldValue: target.aiPriority,
      newValue: action.priority,
    });
  }
  if (newMessage) {
    await linkSource(tx, target.id, ctx.message.id, "update", action);
    await recordTaskEvent(tx, {
      taskId: target.id,
      kind: "source_added",
      actor: "ai",
      messageId: ctx.message.id,
      summary: `Neue Mail hinzugefügt: „${ctx.message.subject ?? "ohne Betreff"}“`,
    });
    if (target.waiting && !ctx.message.isFromMe) {
      latestChange = action.update_summary_de ?? `Antwort von ${ctx.message.fromName ?? ctx.message.fromAddress ?? "unbekannt"} eingetroffen – prüfe, ob du weitermachen kannst`;
      await recordTaskEvent(tx, { taskId: target.id, kind: "reply_received", actor: "ai", messageId: ctx.message.id, summary: latestChange });
    } else if (action.update_summary_de && !deadlineChanged) {
      latestChange = action.update_summary_de;
    }
  }
  if (!deadlineChanged && !priorityChanged && !newMessage) {
    await recordTaskEvent(tx, { taskId: target.id, kind: "ai_updated", actor: "ai", messageId: ctx.message.id, summary: "Vorschlag aus geänderter Mail aktualisiert" });
  }
  await bump(tx, ctx.userId, target.id, {
    aiTitle: action.action_title_de,
    aiNextStep: action.next_step_de,
    aiSummary: ctx.output.summary_de,
    aiPriority: action.priority,
    aiPriorityReason: action.priority_reason_de,
    ...(after !== null ? next : {}),
    aiWhy: action.why_de,
    aiNeeds: action.needs_de,
    requiresAttachmentReading: action.requires_attachment_reading || target.requiresAttachmentReading,
    latestChange,
  });
}

/** Marker jobs go through the outbox table in the same transaction; failures never touch tasks. */
async function queueMarker(tx: Tx, ctx: ApplyContext, taskId: string): Promise<string | null> {
  const a = ctx.account;
  if (a.markerStrategy === "none" || !a.markerAcknowledged) return null;
  if (ctx.message.markerStatus === "applied" || ctx.message.markerStatus === "pending") return null;
  const [op] = await tx
    .insert(markerOperations)
    .values({ accountId: a.id, messageId: ctx.message.id, taskId, operation: "set", strategy: a.markerStrategy })
    .onConflictDoNothing()
    .returning({ id: markerOperations.id });
  await tx.update(messages).set({ markerStatus: "pending" }).where(eq(messages.id, ctx.message.id));
  ctx.message.markerStatus = "pending";
  return op?.id ?? null;
}

interface ClarificationDraft {
  kind: string;
  question: string;
  reason: string;
  excerpt: string | null;
  subject: string | null;
  options: Array<{ id: string; label: string; scope: "once" | "permanent" }>;
  dedupeKey: string;
  taskId: string | null;
  actionIndex: number | null;
}

async function upsertClarification(tx: Tx, ctx: ApplyContext, d: ClarificationDraft): Promise<string | null> {
  const [row] = await tx
    .insert(clarificationRequests)
    .values({
      userId: ctx.userId,
      taskId: d.taskId,
      messageId: ctx.message.id,
      kind: d.kind,
      question: d.question,
      reason: d.reason,
      excerpt: d.excerpt,
      subject: d.subject,
      options: d.options,
      allowFreeText: d.kind === "other" || d.kind === "deadline_conflict",
      dedupeKey: d.dedupeKey,
      analysisId: ctx.analysisId,
      actionIndex: d.actionIndex,
    })
    .onConflictDoNothing({ target: [clarificationRequests.userId, clarificationRequests.dedupeKey] })
    .returning();
  if (!row) return null; // asked before: never the same question twice
  await recordChange(tx, { userId: ctx.userId, entityType: "clarification", entityId: row.id, op: "upsert", version: row.version });
  return row.id;
}

async function insertClarification(tx: Tx, ctx: ApplyContext, c: AnalysisClarification, index: number): Promise<string | null> {
  const subject = c.subject?.trim().toLowerCase() ?? null;
  const related = c.related_action_index === null ? null : ctx.output.actions[c.related_action_index];
  const dedupeKey =
    HOLDING_KINDS.has(c.kind) && subject
      ? `${c.kind}:${subject}:${ctx.message.id}`
      : c.kind === "merge"
        ? `merge:${ctx.message.id}:${related ? actionKeyOf(related.action_title_de) : index}`
        : `${c.kind}:${ctx.message.id}:${index}`;
  return upsertClarification(tx, ctx, {
    kind: c.kind,
    question: c.question_de,
    reason: c.reason_de,
    excerpt: c.excerpt,
    subject: c.subject,
    options: c.options.map((o) => ({ id: o.id, label: o.label_de, scope: o.may_be_permanent ? "permanent" : "once" })),
    dedupeKey,
    taskId: c.kind === "merge" ? (related?.suggested_existing_task_id ?? null) : null,
    actionIndex: c.related_action_index,
  });
}

/**
 * A mail I sent in a thread is made visible on its open tasks, without changing their status:
 * answering is not proof that a task is done.
 */
export async function noteOwnReplies(tx: Tx, userId: string, messageIds: string[], timeZone: string): Promise<void> {
  const own = await tx.select().from(messages).where(inArray(messages.id, messageIds));
  for (const m of own) {
    if (!m.threadId) continue;
    const linked = await tx
      .selectDistinct({ taskId: taskSources.taskId })
      .from(taskSources)
      .innerJoin(messages, eq(messages.id, taskSources.messageId))
      .innerJoin(tasks, eq(tasks.id, taskSources.taskId))
      .where(and(eq(messages.threadId, m.threadId), ne(messages.id, m.id), inArray(tasks.status, ["todo", "doing"]), eq(tasks.userId, userId), isNull(taskSources.removedAt)));
    for (const { taskId } of linked) {
      const [already] = await tx.select({ id: taskSources.id }).from(taskSources).where(and(eq(taskSources.taskId, taskId), eq(taskSources.messageId, m.id))).limit(1);
      if (already) continue;
      await tx.insert(taskSources).values({ taskId, messageId: m.id, role: "reference", addedBy: "ai", changeSummary: "Eigene Antwort" }).onConflictDoNothing();
      const when = m.sentAt ? new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone }).format(m.sentAt) : "kürzlich";
      await recordTaskEvent(tx, { taskId, kind: "own_reply", actor: "system", messageId: m.id, summary: `Du hast am ${when} in diesem Thread geantwortet` });
      await bump(tx, userId, taskId, { latestChange: `Du hast am ${when} geantwortet – Status bleibt unverändert` });
    }
  }
}

/** Latest successful analysis output of a message, for thread context and held actions. */
export async function latestAnalysis(tx: Executor, messageId: string) {
  const [row] = await tx
    .select()
    .from(schema.messageAnalyses)
    .where(and(eq(schema.messageAnalyses.messageId, messageId), eq(schema.messageAnalyses.status, "succeeded")))
    .orderBy(desc(schema.messageAnalyses.createdAt))
    .limit(1);
  return row ?? null;
}

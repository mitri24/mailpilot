import { and, eq, ne, sql } from "drizzle-orm";
import { AnalysisOutput, Jobs, type ApplyClarificationPayload } from "@mailpilot/contracts";
import { recordChange, recordTaskEvent, schema, userTransaction, type Tx } from "@mailpilot/database";
import { applyAction, HOLDING_KINDS, type ApplyContext, type ApplyOutcome } from "./apply.js";
import type { WorkerDeps } from "./deps.js";

const { clarificationRequests, messageAnalyses, messages, mailAccounts, tasks } = schema;

type ClarificationRow = typeof clarificationRequests.$inferSelect;

async function contextFor(tx: Tx, c: ClarificationRow): Promise<ApplyContext | null> {
  if (!c.analysisId || !c.messageId) return null;
  const [analysis] = await tx.select().from(messageAnalyses).where(eq(messageAnalyses.id, c.analysisId)).limit(1);
  const [message] = await tx.select().from(messages).where(eq(messages.id, c.messageId)).limit(1);
  if (!analysis?.output || !message) return null;
  const [account] = await tx.select().from(mailAccounts).where(eq(mailAccounts.id, message.accountId)).limit(1);
  if (!account) return null;
  return { userId: c.userId, account, message, analysisId: analysis.id, output: AnalysisOutput.parse(analysis.output) };
}

/** Creates the actions that waited for this answer, unless another open question still holds them. */
async function releaseHeld(tx: Tx, c: ClarificationRow, outcome: ApplyOutcome, forceNew = false): Promise<void> {
  const ctx = await contextFor(tx, c);
  if (!ctx) return;
  const others = await tx
    .select()
    .from(clarificationRequests)
    .where(and(eq(clarificationRequests.analysisId, ctx.analysisId), ne(clarificationRequests.id, c.id), eq(clarificationRequests.status, "open")));
  const stillHeld = new Set<number>();
  for (const o of others) {
    if (!HOLDING_KINDS.has(o.kind) && o.kind !== "merge") continue;
    if (o.actionIndex === null) ctx.output.actions.forEach((_, i) => stillHeld.add(i));
    else stillHeld.add(o.actionIndex);
  }
  const indices = c.actionIndex === null ? ctx.output.actions.map((_, i) => i) : [c.actionIndex];
  for (const i of indices) {
    const action = ctx.output.actions[i];
    if (!action || stillHeld.has(i)) continue;
    await applyAction(tx, ctx, forceNew ? { ...action, suggested_existing_task_id: null } : action, outcome, forceNew);
  }
}

async function reopenTask(tx: Tx, c: ClarificationRow): Promise<void> {
  if (!c.taskId) return;
  const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, c.taskId), eq(tasks.userId, c.userId))).for("update");
  if (!task || task.status !== "dismissed") return;
  const to = task.statusBeforeDismiss && task.statusBeforeDismiss !== "dismissed" ? task.statusBeforeDismiss : "todo";
  // The status field version moves on, so a stale offline device cannot silently undo this.
  const [row] = await tx
    .update(tasks)
    .set({
      status: to,
      dismissedAt: null,
      version: sql`${tasks.version} + 1`,
      fieldVersions: sql`jsonb_set(${tasks.fieldVersions}, '{status}', to_jsonb(${tasks.version} + 1))`,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id))
    .returning({ version: tasks.version });
  await recordTaskEvent(tx, { taskId: task.id, kind: "restored", actor: "user", summary: "Nach neuer Mail wieder aufgenommen" });
  await recordChange(tx, { userId: c.userId, entityType: "task", entityId: task.id, op: "upsert", version: row!.version });
}

/** A permanent assignment also answers the same open question on other mails. */
async function answerSiblings(tx: Tx, c: ClarificationRow, outcome: ApplyOutcome): Promise<void> {
  if (c.answerScope !== "permanent" || !c.subject || (c.answerOptionId !== "yes" && c.answerOptionId !== "no")) return;
  const siblings = await tx
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.userId, c.userId),
        eq(clarificationRequests.kind, c.kind),
        eq(clarificationRequests.status, "open"),
        sql`lower(${clarificationRequests.subject}) = lower(${c.subject})`,
        ne(clarificationRequests.id, c.id),
      ),
    )
    .for("update");
  for (const s of siblings) {
    const [updated] = await tx
      .update(clarificationRequests)
      .set({
        status: "answered",
        answerOptionId: c.answerOptionId,
        answerText: "Automatisch beantwortet durch deine dauerhafte Zuordnung",
        answerScope: "once",
        answeredAt: new Date(),
        version: sql`${clarificationRequests.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(clarificationRequests.id, s.id))
      .returning();
    await recordChange(tx, { userId: c.userId, entityType: "clarification", entityId: s.id, op: "upsert", version: updated!.version });
    if (c.answerOptionId === "yes") await releaseHeld(tx, updated!, outcome);
  }
}

export async function applyClarification(deps: WorkerDeps, payload: ApplyClarificationPayload): Promise<void> {
  const [c] = await deps.db.select().from(clarificationRequests).where(eq(clarificationRequests.id, payload.clarificationId)).limit(1);
  if (!c || c.status !== "answered") return;
  const outcome: ApplyOutcome = { created: [], updated: [], clarifications: [], markerOperations: [], skipped: 0 };
  await userTransaction(deps.db, c.userId, async (tx) => {
    const [fresh] = await tx.select().from(clarificationRequests).where(eq(clarificationRequests.id, c.id)).for("update");
    if (!fresh || fresh.status !== "answered") return;
    const answer = fresh.answerOptionId;
    if (HOLDING_KINDS.has(fresh.kind)) {
      if (answer === "yes") await releaseHeld(tx, fresh, outcome);
      await answerSiblings(tx, fresh, outcome);
    } else if (fresh.kind === "merge") {
      if (answer === "merge") await releaseHeld(tx, fresh, outcome);
      if (answer === "separate") await releaseHeld(tx, fresh, outcome, true);
    } else if (fresh.kind === "reopen" && answer === "reopen") {
      await reopenTask(tx, fresh);
    }
  });
  for (const id of outcome.markerOperations) {
    await deps.enqueue(Jobs.applyMarker, { markerOperationId: id }, { jobKey: `marker:${id}`, maxAttempts: 5 });
  }
}

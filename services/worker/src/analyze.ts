import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { AnalyzerError, estimateCostMicros, type AnalysisInput, type AnalysisResult } from "@mailpilot/ai";
import { Jobs, localDate, localMonthStart, type AnalyzeMessagePayload, type TaskStatus } from "@mailpilot/contracts";
import { recordChange, schema, userTransaction, type Executor } from "@mailpilot/database";
import { reduceForAnalysis } from "@mailpilot/mail-connectors";
import type { MessageRow, UserRow, WorkerDeps } from "./deps.js";
import { applyAnalysis, latestAnalysis } from "./apply.js";
import { bumpRunStats } from "./runs.js";
import { ownAddressesOf } from "./scan.js";

const { messages, mailAccounts, users, tasks, taskSources, userRules, clarificationRequests, messageAnalyses } = schema;

/** Spent AI cost this calendar month (user time zone), failed attempts included. */
export async function monthSpendMicros(db: Executor, user: UserRow, now: Date): Promise<number> {
  const { start } = localMonthStart(now, user.timezone);
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${messageAnalyses.costMicros}), 0)::text` })
    .from(messageAnalyses)
    .where(and(eq(messageAnalyses.userId, user.id), gte(messageAnalyses.createdAt, start)));
  return Number(row?.total ?? "0");
}

async function setStatus(db: Executor, messageId: string, set: Partial<typeof messages.$inferInsert>) {
  await db.update(messages).set({ ...set, updatedAt: new Date() }).where(eq(messages.id, messageId));
}

export async function analyzeMessage(deps: WorkerDeps, payload: AnalyzeMessagePayload): Promise<void> {
  const { db } = deps;
  const [message] = await db.select().from(messages).where(eq(messages.id, payload.messageId)).limit(1);
  if (!message || message.deletedAt) return;
  const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, message.accountId)).limit(1);
  if (!account || account.removedAt) return;
  const [user] = await db.select().from(users).where(eq(users.id, account.userId)).limit(1);
  if (!user) return;

  // Unchanged content that was analyzed before is not analyzed again.
  if (!payload.force && message.analysisStatus === "analyzed" && message.analysisContentHash === message.contentHash) return;
  if (message.analysisStatus === "skipped" && !payload.force) return;

  if (!deps.analyzer || !deps.prices) {
    await setStatus(db, message.id, { analysisStatus: "pending", analysisError: deps.analyzerDisabledReason ?? "KI-Analyse ist nicht eingerichtet" });
    return;
  }

  const input = await buildInput(db, user, message, deps.now());
  const inputChars = JSON.stringify(input).length + 12_000; // system prompt and schema
  const estimate = estimateCostMicros(inputChars, deps.expectedOutputTokens, deps.prices);
  const budgetMicros = user.aiMonthlyBudgetCents * 10_000;
  const spent = await monthSpendMicros(db, user, deps.now());
  if (spent + estimate > budgetMicros) {
    // Mail keeps being collected; analysis waits, visibly, until budget is available again.
    await setStatus(db, message.id, { analysisStatus: "budget_paused", analysisError: "Monatliches KI-Budget erreicht" });
    await bumpRunStats(db, payload.runId, { budgetPaused: 1 });
    return;
  }

  const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  let result: AnalysisResult;
  try {
    result = await deps.analyzer.analyze(input);
  } catch (error) {
    const e = error instanceof AnalyzerError ? error : new AnalyzerError("unavailable", String(error), true);
    const attempts = message.analysisAttempts + 1;
    await db.insert(messageAnalyses).values({
      messageId: message.id,
      userId: user.id,
      runId: payload.runId,
      model: deps.analyzer.model,
      promptVersion: "n/a",
      inputHash,
      status: "failed",
      error: `${e.code}: ${e.message}`.slice(0, 1000),
      inputTokens: e.usage?.inputTokens ?? 0,
      outputTokens: e.usage?.outputTokens ?? 0,
      cacheReadTokens: e.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: e.usage?.cacheWriteTokens ?? 0,
      costMicros: e.costMicros,
    });
    const retry = e.retryable && attempts < deps.limits.maxAnalysisAttempts;
    await setStatus(db, message.id, { analysisStatus: retry ? "pending" : "failed", analysisAttempts: attempts, analysisError: e.message.slice(0, 500) });
    if (retry) throw error; // limited retries with backoff by the job queue
    await bumpRunStats(db, payload.runId, { errors: 1 });
    deps.log.warn({ messageId: message.id, code: e.code }, "analysis failed");
    return;
  }

  const outcome = await userTransaction(db, user.id, async (tx) => {
    const [fresh] = await tx.select().from(messages).where(eq(messages.id, message.id)).for("update");
    if (!fresh || fresh.contentHash !== message.contentHash) return null; // changed meanwhile; a new job follows
    const [analysis] = await tx
      .insert(messageAnalyses)
      .values({
        messageId: message.id,
        userId: user.id,
        runId: payload.runId,
        model: result.model,
        promptVersion: result.promptVersion,
        inputHash,
        status: "succeeded",
        output: result.output,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        costMicros: result.costMicros,
        fallbackUsed: result.fallbackUsed,
        adjustments: result.adjustments,
      })
      .returning({ id: messageAnalyses.id });
    const applied = await applyAnalysis(tx, { userId: user.id, account, message: fresh, analysisId: analysis!.id, output: result.output });
    await tx
      .update(messages)
      .set({
        analysisStatus: "analyzed",
        analysisContentHash: fresh.contentHash,
        analysisAttempts: 0,
        analysisError: null,
        analyzedAt: deps.now(),
        language: result.output.language,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, message.id));
    // The account shows "letzte erfolgreiche KI-Analyse", so devices get the change through the feed.
    const [acc] = await tx
      .update(mailAccounts)
      .set({ lastSuccessfulAnalysisAt: deps.now(), version: sql`${mailAccounts.version} + 1` })
      .where(eq(mailAccounts.id, account.id))
      .returning({ version: mailAccounts.version });
    await recordChange(tx, { userId: user.id, entityType: "account", entityId: account.id, op: "upsert", version: acc!.version });
    await bumpRunStats(tx, payload.runId, {
      analyzed: 1,
      tasksCreated: applied.created.length,
      tasksUpdated: applied.updated.length,
      clarifications: applied.clarifications.length,
    });
    return applied;
  });
  for (const id of outcome?.markerOperations ?? []) {
    await deps.enqueue(Jobs.applyMarker, { markerOperationId: id }, { jobKey: `marker:${id}`, maxAttempts: 5 });
  }
}

const effectiveDeadline = (t: typeof tasks.$inferSelect): string | null => {
  if (t.manualDeadlineCleared) return null;
  if (t.manualDeadlineDate) return t.manualDeadlineDate;
  if (t.manualDeadlineAt) return t.manualDeadlineAt.toISOString();
  if (t.aiDeadlineKind === "suggested") return null;
  return t.aiDeadlineDate ?? t.aiDeadlineAt?.toISOString() ?? null;
};

/**
 * Builds the model input with only the context needed: earlier thread messages as short
 * summaries, candidate tasks, confirmed assignments and questions asked before.
 */
export async function buildInput(db: Executor, user: UserRow, message: MessageRow, now: Date): Promise<AnalysisInput> {
  // Signature and repeated quotes are removed; the start of the last quoted mail stays as context.
  const reduced = reduceForAnalysis(message.bodyText, { maxChars: user.maxMessageChars });
  const own = await ownAddressesOf(db, user.id);

  const earlier = message.threadId
    ? await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.threadId, message.threadId),
            ne(messages.id, message.id),
            isNull(messages.deletedAt),
            message.sentAt ? or(lt(messages.sentAt, message.sentAt), isNull(messages.sentAt)) : undefined,
          ),
        )
        .orderBy(desc(messages.sentAt))
        .limit(5)
    : [];
  const thread = [];
  for (const m of earlier.reverse()) {
    const a = await latestAnalysis(db, m.id);
    const summary = (a?.output as { summary_de?: string } | null)?.summary_de ?? (m.snippet ?? m.bodyText).slice(0, 300);
    thread.push({ id: m.id, sentAt: m.sentAt?.toISOString() ?? null, from: m.fromAddress, isFromMe: m.isFromMe, summary });
  }

  const threadMessageIds = [message.id, ...earlier.map((m) => m.id)];
  const threadTasks = await db
    .selectDistinct({ task: tasks })
    .from(tasks)
    .innerJoin(taskSources, eq(taskSources.taskId, tasks.id))
    .where(and(eq(tasks.userId, user.id), inArray(taskSources.messageId, threadMessageIds), isNull(tasks.deletedAt), isNull(tasks.mergedIntoTaskId)));
  const senderTasks = message.fromAddress
    ? await db
        .selectDistinct({ task: tasks })
        .from(tasks)
        .innerJoin(taskSources, eq(taskSources.taskId, tasks.id))
        .innerJoin(messages, eq(messages.id, taskSources.messageId))
        .where(
          and(
            eq(tasks.userId, user.id),
            sql`lower(${messages.fromAddress}) = lower(${message.fromAddress})`,
            inArray(tasks.status, ["todo", "doing"] as TaskStatus[]),
            isNull(tasks.deletedAt),
            isNull(tasks.mergedIntoTaskId),
          ),
        )
        .orderBy(desc(tasks.updatedAt))
        .limit(10)
    : [];
  const threadIds = new Set(threadTasks.map((t) => t.task.id));
  const candidates = [...threadTasks, ...senderTasks.filter((t) => !threadIds.has(t.task.id))].slice(0, 15).map(({ task }) => ({
    id: task.id,
    title: task.manualTitle ?? task.aiTitle ?? "Aufgabe",
    status: task.status as TaskStatus,
    waiting: task.waiting,
    deadline: effectiveDeadline(task),
    summary: task.aiSummary,
    sameThread: threadIds.has(task.id),
  }));

  const rules = await db.select().from(userRules).where(and(eq(userRules.userId, user.id), isNull(userRules.deletedAt)));
  const asked = await db
    .select()
    .from(clarificationRequests)
    .where(and(eq(clarificationRequests.userId, user.id), or(inArray(clarificationRequests.messageId, threadMessageIds), eq(clarificationRequests.status, "open"))))
    .orderBy(desc(clarificationRequests.createdAt))
    .limit(20);

  return {
    today: localDate(now, user.timezone),
    timeZone: user.timezone,
    ownAddresses: [...own],
    displayName: user.displayName,
    message: {
      id: message.id,
      from: message.fromAddress ? { name: message.fromName, address: message.fromAddress } : null,
      to: message.toAddresses,
      cc: message.ccAddresses,
      subject: message.subject,
      sentAt: message.sentAt?.toISOString() ?? null,
      isFromMe: message.isFromMe,
      text: reduced.text,
      quotedContext: reduced.quotedContext,
      truncated: reduced.truncated,
      attachments: message.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    },
    thread,
    candidateTasks: candidates,
    facts: rules.map((r) => ({ kind: r.kind as "membership", subject: r.subject, applies: r.applies })),
    askedQuestions: asked.map((c) => ({
      kind: c.kind,
      subject: c.subject,
      question: c.question,
      status: c.status as "open" | "answered" | "dismissed",
      answer: c.answerOptionId ?? c.answerText,
    })),
  };
}

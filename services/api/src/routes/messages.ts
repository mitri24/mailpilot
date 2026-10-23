import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ErrorBody, Jobs, MessageDetail, MessageList, MessageListQuery, MessageToTask, Task } from "@mailpilot/contracts";
import { schema, type Database } from "@mailpilot/database";
import { notFound } from "../errors.js";
import type { JobQueue } from "../queue.js";
import { withIdempotency } from "../domain/idempotency.js";
import { getMessageDetail, listMessages } from "../domain/messages.js";
import { createTaskFromMessage } from "../domain/task-ops.js";
import { getTaskDto } from "../domain/task-queries.js";
import { authOf, idempotencyKeyOf, type Router } from "./types.js";

const IdParam = z.object({ id: z.uuid() });

export function registerMessageRoutes(r: Router, deps: { db: Database; queue: JobQueue }) {
  const { db, queue } = deps;

  r.get(
    "/v1/messages",
    { schema: { tags: ["messages"], summary: "Importierte Mails durchsuchen", querystring: MessageListQuery, response: { 200: MessageList } } },
    async (request) => ({ messages: await listMessages(db, authOf(request).userId, request.query) }),
  );

  r.get(
    "/v1/messages/:id",
    {
      schema: {
        tags: ["messages"],
        summary: "Sichere Mailansicht (ohne Skripte und Remote-Inhalte) mit Wegen zur Originalmail",
        params: IdParam,
        response: { 200: MessageDetail, 404: ErrorBody },
      },
    },
    async (request) => getMessageDetail(db, authOf(request).userId, request.params.id),
  );

  r.post(
    "/v1/messages/:id/task",
    {
      schema: {
        tags: ["messages"],
        summary: "Übersehene Mail als Aufgabe aufnehmen oder mit bestehender Aufgabe verknüpfen",
        params: IdParam,
        body: MessageToTask,
        response: { 200: Task },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const taskId = await withIdempotency(db, userId, idempotencyKeyOf(request), { m: request.params.id, b: request.body }, async (tx) => ({
        response: await createTaskFromMessage(tx, userId, request.params.id, request.body),
      }));
      const task = await getTaskDto(db, userId, taskId);
      if (!task) throw notFound("Aufgabe");
      return task;
    },
  );

  r.post(
    "/v1/messages/:id/analyze",
    {
      schema: {
        tags: ["messages"],
        summary: "Analyse einer Mail erneut anstoßen (z. B. nach einem Fehler); das Budget gilt weiter",
        params: IdParam,
        response: { 200: z.object({ queued: z.boolean() }), 404: ErrorBody },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const [row] = await db
        .select({ id: schema.messages.id, status: schema.messages.analysisStatus })
        .from(schema.messages)
        .innerJoin(schema.mailAccounts, eq(schema.mailAccounts.id, schema.messages.accountId))
        .where(and(eq(schema.messages.id, request.params.id), eq(schema.mailAccounts.userId, userId)))
        .limit(1);
      if (!row) throw notFound("Mail");
      await db.update(schema.messages).set({ analysisStatus: "pending", analysisAttempts: 0, analysisError: null }).where(eq(schema.messages.id, row.id));
      await queue.add(
        Jobs.analyzeMessage,
        { messageId: row.id, runId: null, force: true },
        { jobKey: `analyze:${row.id}`, queueName: `analyze:${userId}`, maxAttempts: 3 },
      );
      return { queued: true };
    },
  );
}

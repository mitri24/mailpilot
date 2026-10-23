import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ChecklistItem,
  Correction,
  ErrorBody,
  MergeResult,
  MutationResult,
  Task,
  TaskCreate,
  TaskDetail,
  TaskList,
  TaskListQuery,
  TaskNote,
  TaskPatch,
  TaskStatus,
} from "@mailpilot/contracts";
import { schema, userTransaction, type Database } from "@mailpilot/database";
import { notFound } from "../errors.js";
import type { JobQueue } from "../queue.js";
import { toChecklistDto, toNoteDto } from "../domain/dto.js";
import { withIdempotency } from "../domain/idempotency.js";
import { applyMutation } from "../domain/mutations.js";
import {
  applyCorrection,
  createTaskWithExtras,
  getTaskDetail,
  linkSource,
  mergeTasks,
  undoMerge,
  unlinkSource,
} from "../domain/task-ops.js";
import { getTaskDto, tasksToDto } from "../domain/task-queries.js";
import { localDate, addDays } from "../domain/today.js";
import { authOf, idempotencyKeyOf, type Router } from "./types.js";

const { tasks, taskSources, messages, taskNotes, taskChecklistItems, users } = schema;
const IdParam = z.object({ id: z.uuid() });
const WithResult = z.object({ result: MutationResult, task: Task.nullable() });

export function registerTaskRoutes(r: Router, deps: { db: Database; queue: JobQueue }) {
  const { db, queue } = deps;
  const key = (request: Parameters<typeof idempotencyKeyOf>[0]) => idempotencyKeyOf(request) ?? randomUUID();

  r.get(
    "/v1/tasks",
    { schema: { tags: ["tasks"], summary: "Aufgaben filtern und suchen", querystring: TaskListQuery, response: { 200: TaskList } } },
    async (request) => {
      const { userId } = authOf(request);
      const q = request.query;
      const statuses = q.status
        ? q.status.split(",").map((s) => TaskStatus.parse(s.trim()))
        : (["todo", "doing"] as const);
      const conditions = [eq(tasks.userId, userId), isNull(tasks.deletedAt), isNull(tasks.mergedIntoTaskId), inArray(tasks.status, [...statuses])];
      if (q.waiting) conditions.push(eq(tasks.waiting, q.waiting === "true"));
      if (q.priority) conditions.push(sql`coalesce(${tasks.manualPriority}, ${tasks.aiPriority}, 'important') = ${q.priority}`);
      if (q.search) {
        const term = `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        conditions.push(
          or(ilike(tasks.manualTitle, term), ilike(tasks.aiTitle, term), ilike(tasks.aiSummary, term), ilike(tasks.manualNextStep, term), ilike(tasks.aiNextStep, term))!,
        );
      }
      if (q.accountId) {
        conditions.push(
          inArray(
            tasks.id,
            db
              .select({ id: taskSources.taskId })
              .from(taskSources)
              .innerJoin(messages, eq(messages.id, taskSources.messageId))
              .where(and(eq(messages.accountId, q.accountId), isNull(taskSources.removedAt))),
          ),
        );
      }
      if (q.due) {
        const [user] = await db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId));
        const today = localDate(new Date(), user?.tz ?? "Europe/Paris");
        const dueExpr = sql`case when ${tasks.manualDeadlineCleared} then null else coalesce(${tasks.manualDeadlineDate}, (${tasks.manualDeadlineAt} at time zone ${user?.tz ?? "Europe/Paris"})::date, case when ${tasks.aiDeadlineKind} = 'suggested' then null else coalesce(${tasks.aiDeadlineDate}, (${tasks.aiDeadlineAt} at time zone ${user?.tz ?? "Europe/Paris"})::date) end) end`;
        if (q.due === "overdue") conditions.push(sql`${dueExpr} < ${today}::date`);
        if (q.due === "today") conditions.push(sql`${dueExpr} <= ${today}::date`);
        if (q.due === "week") conditions.push(sql`${dueExpr} <= ${addDays(today, 7)}::date`);
        if (q.due === "none") conditions.push(sql`${dueExpr} is null`);
      }
      const rows = await db
        .select()
        .from(tasks)
        .where(and(...conditions))
        .orderBy(sql`${tasks.sortKey} asc nulls last`, desc(tasks.updatedAt))
        .limit(q.limit);
      return { tasks: await tasksToDto(db, rows) };
    },
  );

  r.post(
    "/v1/tasks",
    { schema: { tags: ["tasks"], summary: "Eigene Aufgabe anlegen (optional mit Mails und Notiz)", body: TaskCreate, response: { 200: Task } } },
    async (request) => {
      const { userId } = authOf(request);
      const id = await withIdempotency(db, userId, idempotencyKeyOf(request), request.body, async (tx) => ({
        response: await createTaskWithExtras(tx, userId, request.body),
      }));
      const task = await getTaskDto(db, userId, id);
      if (!task) throw notFound("Aufgabe");
      return task;
    },
  );

  r.get(
    "/v1/tasks/:id",
    { schema: { tags: ["tasks"], summary: "Aufgabendetail mit Quellen, Notizen, Checkliste und Verlauf", params: IdParam, response: { 200: TaskDetail, 404: ErrorBody } } },
    async (request) => getTaskDetail(db, authOf(request).userId, request.params.id),
  );

  r.patch(
    "/v1/tasks/:id",
    {
      schema: {
        tags: ["tasks"],
        summary: "Aufgabe ändern; Felder, die der Server nach baseVersion geändert hat, werden nicht überschrieben",
        params: IdParam,
        body: z.object({ baseVersion: z.number().int(), patch: TaskPatch }),
        response: { 200: WithResult },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const result = await applyMutation(db, queue, userId, {
        idempotencyKey: key(request),
        type: "task.update",
        entityId: request.params.id,
        baseVersion: request.body.baseVersion,
        payload: request.body.patch,
      });
      return { result, task: await getTaskDto(db, userId, request.params.id) };
    },
  );

  for (const action of ["dismiss", "restore"] as const) {
    r.post(
      `/v1/tasks/:id/${action}`,
      {
        schema: {
          tags: ["tasks"],
          summary: action === "dismiss" ? "Als nicht relevant markieren (rückgängig machbar)" : "Nicht relevant rückgängig machen",
          params: IdParam,
          body: z.object({ baseVersion: z.number().int() }),
          response: { 200: WithResult },
        },
      },
      async (request) => {
        const { userId } = authOf(request);
        const result = await applyMutation(db, queue, userId, {
          idempotencyKey: key(request),
          type: action === "dismiss" ? "task.dismiss" : "task.restore",
          entityId: request.params.id,
          baseVersion: request.body.baseVersion,
        });
        return { result, task: await getTaskDto(db, userId, request.params.id) };
      },
    );
  }

  r.post(
    "/v1/tasks/:id/merge",
    { schema: { tags: ["tasks"], summary: "In eine andere Aufgabe übernehmen (rückgängig machbar)", params: IdParam, body: z.object({ intoTaskId: z.uuid() }), response: { 200: MergeResult } } },
    async (request) => {
      const { userId } = authOf(request);
      const mergeId = await withIdempotency(db, userId, idempotencyKeyOf(request), { merge: request.params.id, into: request.body.intoTaskId }, async (tx) => ({
        response: await mergeTasks(tx, userId, request.params.id, request.body.intoTaskId),
      }));
      const task = await getTaskDto(db, userId, request.body.intoTaskId);
      return { mergeId, task: task! };
    },
  );

  r.post(
    "/v1/merges/:id/undo",
    { schema: { tags: ["tasks"], summary: "Zusammenführung rückgängig machen", params: IdParam, response: { 200: Task } } },
    async (request) => {
      const { userId } = authOf(request);
      const sourceId = await userTransaction(db, userId, (tx) => undoMerge(tx, userId, request.params.id));
      const task = await getTaskDto(db, userId, sourceId);
      if (!task) throw notFound("Aufgabe");
      return task;
    },
  );

  r.post(
    "/v1/tasks/:id/corrections",
    {
      schema: {
        tags: ["tasks"],
        summary: "Korrektur: keine Aufgabe, falsche Priorität, Frist falsch, gehört zu bestehender Aufgabe",
        params: IdParam,
        body: Correction,
        response: { 200: z.object({ task: Task, mergeId: z.uuid().nullable() }) },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const out = await withIdempotency(db, userId, idempotencyKeyOf(request), { id: request.params.id, c: request.body }, async (tx) => ({
        response: await applyCorrection(tx, userId, request.params.id, request.body),
      }));
      const task = await getTaskDto(db, userId, out.taskId);
      if (!task) throw notFound("Aufgabe");
      return { task, mergeId: out.mergeId };
    },
  );

  r.post(
    "/v1/tasks/:id/sources",
    { schema: { tags: ["tasks"], summary: "Mail mit Aufgabe verknüpfen", params: IdParam, body: z.object({ messageId: z.uuid() }), response: { 200: Task } } },
    async (request) => {
      const { userId } = authOf(request);
      await userTransaction(db, userId, (tx) => linkSource(tx, userId, request.params.id, request.body.messageId));
      return (await getTaskDto(db, userId, request.params.id))!;
    },
  );

  r.delete(
    "/v1/tasks/:id/sources/:messageId",
    { schema: { tags: ["tasks"], summary: "Mail-Verknüpfung lösen", params: z.object({ id: z.uuid(), messageId: z.uuid() }), response: { 200: Task } } },
    async (request) => {
      const { userId } = authOf(request);
      await userTransaction(db, userId, (tx) => unlinkSource(tx, userId, request.params.id, request.params.messageId));
      return (await getTaskDto(db, userId, request.params.id))!;
    },
  );

  // ----------------------------------------------------------- notes

  r.post(
    "/v1/tasks/:id/notes",
    {
      schema: {
        tags: ["notes"],
        summary: "Notiz anlegen",
        params: IdParam,
        body: z.object({ id: z.uuid().optional(), body: z.string().min(1).max(20000) }),
        response: { 200: z.object({ result: MutationResult, note: TaskNote.nullable() }) },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const noteId = request.body.id ?? randomUUID();
      const result = await applyMutation(db, queue, userId, {
        idempotencyKey: key(request),
        type: "note.create",
        entityId: noteId,
        payload: { taskId: request.params.id, body: request.body.body },
      });
      const [note] = await db.select().from(taskNotes).where(and(eq(taskNotes.id, noteId), eq(taskNotes.userId, userId)));
      return { result, note: note ? toNoteDto(note) : null };
    },
  );

  r.patch(
    "/v1/notes/:id",
    {
      schema: {
        tags: ["notes"],
        summary: "Notiz ändern; bei gleichzeitiger Änderung bleiben beide Fassungen erhalten",
        params: IdParam,
        body: z.object({ baseVersion: z.number().int(), body: z.string().min(1).max(20000) }),
        response: { 200: z.object({ result: MutationResult }) },
      },
    },
    async (request) => ({
      result: await applyMutation(db, queue, authOf(request).userId, {
        idempotencyKey: key(request),
        type: "note.update",
        entityId: request.params.id,
        baseVersion: request.body.baseVersion,
        payload: { body: request.body.body },
      }),
    }),
  );

  r.delete(
    "/v1/notes/:id",
    { schema: { tags: ["notes"], summary: "Notiz löschen", params: IdParam, querystring: z.object({ baseVersion: z.coerce.number().int() }), response: { 200: z.object({ result: MutationResult }) } } },
    async (request) => ({
      result: await applyMutation(db, queue, authOf(request).userId, {
        idempotencyKey: key(request),
        type: "note.delete",
        entityId: request.params.id,
        baseVersion: request.query.baseVersion,
      }),
    }),
  );

  // ----------------------------------------------------------- checklist

  r.post(
    "/v1/tasks/:id/checklist",
    {
      schema: {
        tags: ["checklist"],
        summary: "Checklisten-Eintrag anlegen",
        params: IdParam,
        body: z.object({ id: z.uuid().optional(), title: z.string().min(1).max(300) }),
        response: { 200: z.object({ result: MutationResult, item: ChecklistItem.nullable() }) },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const itemId = request.body.id ?? randomUUID();
      const result = await applyMutation(db, queue, userId, {
        idempotencyKey: key(request),
        type: "checklist.create",
        entityId: itemId,
        payload: { taskId: request.params.id, title: request.body.title },
      });
      const [item] = await db.select().from(taskChecklistItems).where(eq(taskChecklistItems.id, itemId));
      return { result, item: item ? toChecklistDto(item) : null };
    },
  );

  r.patch(
    "/v1/checklist/:id",
    {
      schema: {
        tags: ["checklist"],
        summary: "Checklisten-Eintrag ändern",
        params: IdParam,
        body: z.object({
          baseVersion: z.number().int(),
          title: z.string().min(1).max(300).optional(),
          done: z.boolean().optional(),
          position: z.number().optional(),
        }),
        response: { 200: z.object({ result: MutationResult }) },
      },
    },
    async (request) => {
      const { baseVersion, ...payload } = request.body;
      return {
        result: await applyMutation(db, queue, authOf(request).userId, {
          idempotencyKey: key(request),
          type: "checklist.update",
          entityId: request.params.id,
          baseVersion,
          payload,
        }),
      };
    },
  );

  r.delete(
    "/v1/checklist/:id",
    { schema: { tags: ["checklist"], summary: "Checklisten-Eintrag löschen", params: IdParam, querystring: z.object({ baseVersion: z.coerce.number().int() }), response: { 200: z.object({ result: MutationResult }) } } },
    async (request) => ({
      result: await applyMutation(db, queue, authOf(request).userId, {
        idempotencyKey: key(request),
        type: "checklist.delete",
        entityId: request.params.id,
        baseVersion: request.query.baseVersion,
      }),
    }),
  );
}

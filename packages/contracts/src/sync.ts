import { z } from "zod";
import { Account } from "./accounts.js";
import { AnswerScope, SyncEntityType } from "./enums.js";
import { Clarification, Rule } from "./clarifications.js";
import { Cursor, Id, Timestamp } from "./primitives.js";
import { Settings } from "./settings.js";
import { ChecklistItem, ManualDeadline, Task, TaskNote, TaskPatch } from "./tasks.js";
import { Priority } from "./enums.js";

/** One change-log entry. Deletes carry no data (tombstone). */
export const Change = z
  .discriminatedUnion("entityType", [
    z.object({ seq: Cursor, entityType: z.literal("task"), entityId: Id, op: z.enum(["upsert", "delete"]), version: z.number().int(), data: Task.nullable() }),
    z.object({ seq: Cursor, entityType: z.literal("note"), entityId: Id, op: z.enum(["upsert", "delete"]), version: z.number().int(), data: TaskNote.nullable() }),
    z.object({ seq: Cursor, entityType: z.literal("checklist_item"), entityId: Id, op: z.enum(["upsert", "delete"]), version: z.number().int(), data: ChecklistItem.nullable() }),
    z.object({ seq: Cursor, entityType: z.literal("clarification"), entityId: Id, op: z.enum(["upsert", "delete"]), version: z.number().int(), data: Clarification.nullable() }),
    z.object({ seq: Cursor, entityType: z.literal("account"), entityId: Id, op: z.enum(["upsert", "delete"]), version: z.number().int(), data: Account.nullable() }),
    z.object({ seq: Cursor, entityType: z.literal("rule"), entityId: Id, op: z.enum(["upsert", "delete"]), version: z.number().int(), data: Rule.nullable() }),
    z.object({ seq: Cursor, entityType: z.literal("settings"), entityId: Id, op: z.enum(["upsert", "delete"]), version: z.number().int(), data: Settings.nullable() }),
  ])
  .meta({ id: "Change" });
export type Change = z.infer<typeof Change>;

export const ChangesQuery = z.object({
  cursor: Cursor.optional().describe("Last seq the client has applied; omit for a full snapshot"),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const ChangesResponse = z
  .object({
    changes: z.array(Change),
    nextCursor: Cursor,
    hasMore: z.boolean(),
    resetRequired: z.boolean().describe("Cursor is older than retained history; client must refetch"),
    serverTime: Timestamp,
  })
  .meta({ id: "ChangesResponse" });
export type ChangesResponse = z.infer<typeof ChangesResponse>;

const Base = { idempotencyKey: z.uuid(), clientTimestamp: Timestamp.optional() };

export const Mutation = z
  .discriminatedUnion("type", [
    z.object({
      ...Base,
      type: z.literal("task.create"),
      entityId: Id,
      payload: z.object({
        title: z.string().min(1).max(300),
        nextStep: z.string().max(1000).nullable().optional(),
        priority: Priority.optional(),
        deadline: ManualDeadline.nullable().optional(),
      }),
    }),
    z.object({ ...Base, type: z.literal("task.update"), entityId: Id, baseVersion: z.number().int(), payload: TaskPatch }),
    z.object({ ...Base, type: z.literal("task.dismiss"), entityId: Id, baseVersion: z.number().int() }),
    z.object({ ...Base, type: z.literal("task.restore"), entityId: Id, baseVersion: z.number().int() }),
    z.object({ ...Base, type: z.literal("note.create"), entityId: Id, payload: z.object({ taskId: Id, body: z.string().min(1).max(20000) }) }),
    z.object({ ...Base, type: z.literal("note.update"), entityId: Id, baseVersion: z.number().int(), payload: z.object({ body: z.string().min(1).max(20000) }) }),
    z.object({ ...Base, type: z.literal("note.delete"), entityId: Id, baseVersion: z.number().int() }),
    z.object({ ...Base, type: z.literal("checklist.create"), entityId: Id, payload: z.object({ taskId: Id, title: z.string().min(1).max(300), position: z.number().optional() }) }),
    z.object({
      ...Base,
      type: z.literal("checklist.update"),
      entityId: Id,
      baseVersion: z.number().int(),
      payload: z.object({ title: z.string().min(1).max(300).optional(), done: z.boolean().optional(), position: z.number().optional() }),
    }),
    z.object({ ...Base, type: z.literal("checklist.delete"), entityId: Id, baseVersion: z.number().int() }),
    z.object({
      ...Base,
      type: z.literal("clarification.answer"),
      entityId: Id,
      payload: z.object({ optionId: z.string().max(40).nullable().optional(), text: z.string().max(2000).nullable().optional(), scope: AnswerScope }),
    }),
  ])
  .meta({ id: "Mutation" });
export type Mutation = z.infer<typeof Mutation>;

export const MutationBatch = z
  .object({ mutations: z.array(Mutation).min(1).max(100) })
  .meta({ id: "MutationBatch" });

export const MutationResult = z
  .object({
    idempotencyKey: z.uuid(),
    status: z.enum(["applied", "conflict", "rejected", "duplicate"]),
    entityType: SyncEntityType,
    entityId: Id,
    version: z.number().int().nullable(),
    conflictingFields: z.array(z.string()).describe("Fields not applied because the server changed them after baseVersion"),
    createdEntityId: Id.nullable().describe("e.g. the conflict copy of a note"),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .meta({ id: "MutationResult" });
export type MutationResult = z.infer<typeof MutationResult>;

export const MutationBatchResult = z
  .object({ results: z.array(MutationResult) })
  .meta({ id: "MutationBatchResult" });

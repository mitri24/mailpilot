import { z } from "zod";
import {
  DeadlineKind,
  DeadlinePrecision,
  EstimateSource,
  Priority,
  TaskEventKind,
  TaskOrigin,
  TaskStatus,
} from "./enums.js";
import { DateOnly, Id, Timestamp } from "./primitives.js";

/** A deadline is either a pure date or a point in time; never both, never an invented time. */
export const Deadline = z
  .object({
    date: DateOnly.nullable().describe("Set when precision is date"),
    dateTime: Timestamp.nullable().describe("Set when precision is datetime"),
    precision: DeadlinePrecision,
    kind: DeadlineKind,
    sourceQuote: z.string().nullable(),
  })
  .meta({ id: "Deadline" });
export type Deadline = z.infer<typeof Deadline>;

export const ManualDeadline = z
  .object({
    date: DateOnly.nullable(),
    dateTime: Timestamp.nullable(),
    precision: DeadlinePrecision,
  })
  .meta({ id: "ManualDeadline" });
export type ManualDeadline = z.infer<typeof ManualDeadline>;

export const AiSuggestion = z
  .object({
    title: z.string().nullable(),
    nextStep: z.string().nullable(),
    summary: z.string().nullable(),
    priority: Priority.nullable(),
    priorityReason: z.string().nullable(),
    deadline: Deadline.nullable(),
    why: z.string().nullable(),
  })
  .meta({ id: "AiSuggestion" });

export const ManualOverrides = z
  .object({
    title: z.string().nullable(),
    nextStep: z.string().nullable(),
    priority: Priority.nullable(),
    deadline: ManualDeadline.nullable(),
    deadlineCleared: z.boolean(),
  })
  .meta({ id: "ManualOverrides" });

export const SourceRef = z
  .object({
    messageId: Id,
    accountId: Id,
    subject: z.string().nullable(),
    fromName: z.string().nullable(),
    fromAddress: z.string().nullable(),
    sentAt: Timestamp.nullable(),
  })
  .meta({ id: "SourceRef" });

/** Effective values (manual over AI) plus both raw layers, so clients never have to guess. */
export const Task = z
  .object({
    id: Id,
    version: z.number().int(),
    origin: TaskOrigin,
    status: TaskStatus,
    waiting: z.boolean().describe("Warte auf Antwort"),
    waitingCheckAt: DateOnly.nullable(),
    snoozedUntil: Timestamp.nullable(),
    plannedFor: DateOnly.nullable().describe("Für diesen Tag eingeplant"),
    sortKey: z.number().nullable().describe("Manual ordering; lower first"),
    title: z.string(),
    nextStep: z.string().nullable(),
    summary: z.string().nullable(),
    priority: Priority,
    priorityReason: z.string().nullable(),
    priorityIsManual: z.boolean(),
    deadline: Deadline.nullable(),
    deadlineIsManual: z.boolean(),
    why: z.string().nullable().describe("Warum sehe ich diese Aufgabe?"),
    requiresAttachmentReading: z.boolean(),
    estimatedMinutes: z.number().int().nullable(),
    estimateSource: EstimateSource.nullable(),
    ai: AiSuggestion,
    manual: ManualOverrides,
    accountIds: z.array(Id),
    primarySource: SourceRef.nullable(),
    sourceCount: z.number().int(),
    openClarifications: z.number().int(),
    latestChange: z.string().nullable().describe("Neueste relevante Änderung, z. B. verschobene Frist"),
    doneAt: Timestamp.nullable(),
    dismissedAt: Timestamp.nullable(),
    mergedIntoTaskId: Id.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Task" });
export type Task = z.infer<typeof Task>;

export const TaskSource = z
  .object({
    id: Id,
    taskId: Id,
    messageId: Id,
    accountId: Id,
    role: z.enum(["origin", "update", "reference"]),
    addedBy: z.enum(["ai", "user"]),
    subject: z.string().nullable(),
    fromName: z.string().nullable(),
    fromAddress: z.string().nullable(),
    sentAt: Timestamp.nullable(),
    evidenceQuotes: z.array(z.string()),
    attachments: z.array(
      z.object({ filename: z.string().nullable(), contentType: z.string().nullable(), size: z.number().int().nullable() }),
    ),
    changeSummary: z.string().nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "TaskSource" });
export type TaskSource = z.infer<typeof TaskSource>;

export const TaskNote = z
  .object({
    id: Id,
    taskId: Id,
    version: z.number().int(),
    body: z.string(),
    conflictOfNoteId: Id.nullable().describe("Set when this note keeps a concurrent edit of another note"),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "TaskNote" });
export type TaskNote = z.infer<typeof TaskNote>;

export const ChecklistItem = z
  .object({
    id: Id,
    taskId: Id,
    version: z.number().int(),
    title: z.string(),
    done: z.boolean(),
    position: z.number(),
    source: z.enum(["ai", "user"]),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "ChecklistItem" });
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export const TaskEvent = z
  .object({
    id: Id,
    taskId: Id,
    kind: TaskEventKind,
    actor: z.enum(["ai", "user", "system"]),
    messageId: Id.nullable(),
    summary: z.string(),
    oldValue: z.unknown().nullable(),
    newValue: z.unknown().nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "TaskEvent" });
export type TaskEvent = z.infer<typeof TaskEvent>;

export const TaskDetail = z
  .object({
    task: Task,
    sources: z.array(TaskSource),
    notes: z.array(TaskNote),
    checklist: z.array(ChecklistItem),
    events: z.array(TaskEvent),
  })
  .meta({ id: "TaskDetail" });
export type TaskDetail = z.infer<typeof TaskDetail>;

/** Fields a client may change. Each field is checked against its own last-change version. */
export const TaskPatch = z
  .object({
    status: TaskStatus.optional(),
    waiting: z.boolean().optional(),
    waitingCheckAt: DateOnly.nullable().optional(),
    snoozedUntil: Timestamp.nullable().optional(),
    plannedFor: DateOnly.nullable().optional(),
    sortKey: z.number().nullable().optional(),
    title: z.string().min(1).max(300).nullable().optional().describe("null clears the manual title"),
    nextStep: z.string().max(1000).nullable().optional(),
    priority: Priority.nullable().optional().describe("null returns to the AI priority"),
    deadline: ManualDeadline.nullable().optional(),
    deadlineCleared: z.boolean().optional(),
    estimatedMinutes: z.number().int().min(1).max(10000).nullable().optional(),
  })
  .meta({ id: "TaskPatch" });
export type TaskPatch = z.infer<typeof TaskPatch>;

export const TaskCreate = z
  .object({
    id: Id.optional().describe("Client-generated id for offline creation"),
    title: z.string().min(1).max(300),
    nextStep: z.string().max(1000).nullable().optional(),
    priority: Priority.optional(),
    deadline: ManualDeadline.nullable().optional(),
    note: z.string().max(20000).optional(),
    sourceMessageIds: z.array(Id).max(20).optional(),
    estimatedMinutes: z.number().int().min(1).max(10000).optional(),
  })
  .meta({ id: "TaskCreate" });
export type TaskCreate = z.infer<typeof TaskCreate>;

export const TaskListQuery = z.object({
  status: z.string().optional().describe("Comma-separated statuses"),
  accountId: Id.optional(),
  priority: Priority.optional(),
  due: z.enum(["overdue", "today", "week", "none"]).optional(),
  waiting: z.enum(["true", "false"]).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const TaskList = z.object({ tasks: z.array(Task) }).meta({ id: "TaskList" });

export const Correction = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("not_a_task") }),
    z.object({ kind: z.literal("wrong_priority"), priority: Priority }),
    z.object({ kind: z.literal("wrong_deadline"), deadline: ManualDeadline.nullable() }),
    z.object({ kind: z.literal("belongs_to"), taskId: Id }),
  ])
  .meta({ id: "Correction" });
export type Correction = z.infer<typeof Correction>;

export const MergeResult = z
  .object({ mergeId: Id, task: Task })
  .meta({ id: "MergeResult" });

export const Today = z
  .object({
    next: z.array(Task).describe("Die drei nächsten sinnvollen Aufgaben"),
    moreUrgent: z.array(Task).describe("Weitere kritische oder überfällige Aufgaben, nie abgeschnitten"),
    waitingCount: z.number().int(),
    canWaitCount: z.number().int(),
    openClarifications: z.number().int(),
    lastSuccessfulUpdateAt: Timestamp.nullable(),
    pendingAnalysisCount: z.number().int(),
    accountsNeedingAttention: z.array(z.object({ accountId: Id, displayName: z.string(), problem: z.string(), action: z.string() })),
    generatedAt: Timestamp,
  })
  .meta({ id: "Today" });
export type Today = z.infer<typeof Today>;

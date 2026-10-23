import type {
  Account,
  AccountCapabilities,
  ChecklistItem,
  Clarification,
  Deadline,
  MarkerStrategy,
  Priority,
  Rule,
  Settings,
  Task,
  TaskEvent,
  TaskNote,
} from "@mailpilot/contracts";
import type { schema } from "@mailpilot/database";

type TaskRow = typeof schema.tasks.$inferSelect;
type NoteRow = typeof schema.taskNotes.$inferSelect;
type ChecklistRow = typeof schema.taskChecklistItems.$inferSelect;
type EventRow = typeof schema.taskEvents.$inferSelect;
type ClarificationRow = typeof schema.clarificationRequests.$inferSelect;
type AccountRow = typeof schema.mailAccounts.$inferSelect;
type RuleRow = typeof schema.userRules.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();

export interface TaskExtras {
  accountIds: string[];
  primarySource: Task["primarySource"];
  sourceCount: number;
  openClarifications: number;
}

export const emptyExtras: TaskExtras = { accountIds: [], primarySource: null, sourceCount: 0, openClarifications: 0 };

function aiDeadline(row: TaskRow): Deadline | null {
  if (!row.aiDeadlinePrecision || (!row.aiDeadlineDate && !row.aiDeadlineAt)) return null;
  const precision = row.aiDeadlinePrecision === "datetime" ? "datetime" : "date";
  return {
    date: precision === "date" ? row.aiDeadlineDate : null,
    dateTime: precision === "datetime" ? iso(row.aiDeadlineAt) : null,
    precision,
    kind: (row.aiDeadlineKind as Deadline["kind"] | null) ?? "uncertain",
    sourceQuote: row.aiDeadlineQuote,
  };
}

function manualDeadline(row: TaskRow): Deadline | null {
  if (!row.manualDeadlinePrecision || (!row.manualDeadlineDate && !row.manualDeadlineAt)) return null;
  const precision = row.manualDeadlinePrecision === "datetime" ? "datetime" : "date";
  return {
    date: precision === "date" ? row.manualDeadlineDate : null,
    dateTime: precision === "datetime" ? iso(row.manualDeadlineAt) : null,
    precision,
    kind: "explicit",
    sourceQuote: null,
  };
}

/** Manual values always win over AI suggestions; AI values are kept for transparency. */
export function effectiveTask(row: TaskRow) {
  const manualDl = manualDeadline(row);
  const deadline = row.manualDeadlineCleared ? null : (manualDl ?? aiDeadline(row));
  const priority = (row.manualPriority ?? row.aiPriority ?? "important") as Priority;
  return {
    title: row.manualTitle ?? row.aiTitle ?? "Aufgabe ohne Titel",
    nextStep: row.manualNextStep ?? row.aiNextStep,
    priority,
    priorityIsManual: row.manualPriority != null,
    priorityReason: row.manualPriority != null ? "Von dir festgelegt" : row.aiPriorityReason,
    deadline,
    deadlineIsManual: row.manualDeadlineCleared || manualDl != null,
  };
}

export function toTaskDto(row: TaskRow, extras: TaskExtras = emptyExtras): Task {
  const eff = effectiveTask(row);
  return {
    id: row.id,
    version: row.version,
    origin: row.origin as Task["origin"],
    status: row.status as Task["status"],
    waiting: row.waiting,
    waitingCheckAt: row.waitingCheckAt,
    snoozedUntil: iso(row.snoozedUntil),
    plannedFor: row.plannedFor,
    sortKey: row.sortKey,
    title: eff.title,
    nextStep: eff.nextStep,
    summary: row.aiSummary,
    priority: eff.priority,
    priorityReason: eff.priorityReason,
    priorityIsManual: eff.priorityIsManual,
    deadline: eff.deadline,
    deadlineIsManual: eff.deadlineIsManual,
    why: row.aiWhy,
    requiresAttachmentReading: row.requiresAttachmentReading,
    estimatedMinutes: row.estimatedMinutes,
    estimateSource: row.estimateSource as Task["estimateSource"],
    ai: {
      title: row.aiTitle,
      nextStep: row.aiNextStep,
      summary: row.aiSummary,
      priority: row.aiPriority as Priority | null,
      priorityReason: row.aiPriorityReason,
      deadline: aiDeadline(row),
      why: row.aiWhy,
    },
    manual: {
      title: row.manualTitle,
      nextStep: row.manualNextStep,
      priority: row.manualPriority as Priority | null,
      deadline:
        row.manualDeadlinePrecision && (row.manualDeadlineDate || row.manualDeadlineAt)
          ? {
              date: row.manualDeadlinePrecision === "date" ? row.manualDeadlineDate : null,
              dateTime: row.manualDeadlinePrecision === "datetime" ? iso(row.manualDeadlineAt) : null,
              precision: row.manualDeadlinePrecision as "date" | "datetime",
            }
          : null,
      deadlineCleared: row.manualDeadlineCleared,
    },
    accountIds: extras.accountIds,
    primarySource: extras.primarySource,
    sourceCount: extras.sourceCount,
    openClarifications: extras.openClarifications,
    latestChange: row.latestChange,
    doneAt: iso(row.doneAt),
    dismissedAt: iso(row.dismissedAt),
    mergedIntoTaskId: row.mergedIntoTaskId,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

export const toNoteDto = (row: NoteRow): TaskNote => ({
  id: row.id,
  taskId: row.taskId,
  version: row.version,
  body: row.body,
  conflictOfNoteId: row.conflictOfNoteId,
  createdAt: isoReq(row.createdAt),
  updatedAt: isoReq(row.updatedAt),
});

export const toChecklistDto = (row: ChecklistRow): ChecklistItem => ({
  id: row.id,
  taskId: row.taskId,
  version: row.version,
  title: row.title,
  done: row.done,
  position: row.position,
  source: row.source as ChecklistItem["source"],
  createdAt: isoReq(row.createdAt),
  updatedAt: isoReq(row.updatedAt),
});

export const toEventDto = (row: EventRow): TaskEvent => ({
  id: row.id,
  taskId: row.taskId,
  kind: row.kind as TaskEvent["kind"],
  actor: row.actor as TaskEvent["actor"],
  messageId: row.messageId,
  summary: row.summary,
  oldValue: row.oldValue ?? null,
  newValue: row.newValue ?? null,
  createdAt: isoReq(row.createdAt),
});

export const toClarificationDto = (row: ClarificationRow): Clarification => ({
  id: row.id,
  version: row.version,
  kind: row.kind as Clarification["kind"],
  status: row.status as Clarification["status"],
  question: row.question,
  reason: row.reason,
  excerpt: row.excerpt,
  options: row.options,
  allowFreeText: row.allowFreeText,
  taskId: row.taskId,
  messageId: row.messageId,
  answer: row.answeredAt
    ? {
        optionId: row.answerOptionId,
        text: row.answerText,
        scope: (row.answerScope as "once" | "permanent" | null) ?? "once",
        answeredAt: isoReq(row.answeredAt),
      }
    : null,
  createdAt: isoReq(row.createdAt),
  updatedAt: isoReq(row.updatedAt),
});

/** Strategies whose effect is not reliably visible in Apple Mail for this account. */
const markerReliability: Record<MarkerStrategy, boolean> = {
  none: true,
  imap_keyword: false,
  imap_flagged: true,
  imap_copy_folder: true,
  gmail_label: false,
  graph_category: false,
  graph_flag: false,
};

export function toAccountDto(row: AccountRow, extras: { pendingAnalysisCount: number; markerFailures: number }): Account {
  const strategy = (row.markerStrategy as MarkerStrategy) ?? "none";
  return {
    id: row.id,
    version: row.version,
    provider: row.provider as Account["provider"],
    displayName: row.displayName,
    emailAddress: row.emailAddress,
    aliases: row.aliases,
    status: row.status as Account["status"],
    capabilities: (row.capabilities as AccountCapabilities | null) ?? null,
    marker: {
      strategy,
      keyword: row.markerKeyword,
      folder: row.markerFolder,
      acknowledgedLimitations: row.markerAcknowledged,
    },
    markerReliable: markerReliability[strategy],
    initialImportDays: row.initialImportDays,
    includeSent: row.includeSent,
    lastSuccessfulFetchAt: iso(row.lastSuccessfulFetchAt),
    lastSuccessfulAnalysisAt: iso(row.lastSuccessfulAnalysisAt),
    pendingAnalysisCount: extras.pendingAnalysisCount,
    markerFailures: extras.markerFailures,
    lastError:
      row.lastErrorCode && row.lastErrorAt
        ? { code: row.lastErrorCode, message: row.lastErrorMessage ?? "", at: isoReq(row.lastErrorAt), action: row.lastErrorAction }
        : null,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

const ruleDescription = (row: RuleRow): string => {
  switch (row.kind) {
    case "membership":
      return row.applies ? `Du gehörst zu „${row.subject}“` : `Du gehörst nicht zu „${row.subject}“`;
    case "ignore_sender":
      return `Mails von ${row.subject} erzeugen keine Aufgaben`;
    case "sender_relevance":
      return row.applies ? `Mails von ${row.subject} sind für dich relevant` : `Mails von ${row.subject} sind meist nicht relevant`;
    default:
      return row.applies ? `Zuständig: ${row.subject}` : `Nicht zuständig: ${row.subject}`;
  }
};

export const toRuleDto = (row: RuleRow): Rule => ({
  id: row.id,
  version: row.version,
  kind: row.kind as Rule["kind"],
  subject: row.subject,
  value: { applies: row.applies, note: row.note },
  description: ruleDescription(row),
  sourceClarificationId: row.sourceClarificationId,
  createdAt: isoReq(row.createdAt),
  updatedAt: isoReq(row.updatedAt),
});

export const toSettingsDto = (row: UserRow): Settings => ({
  version: row.settingsVersion,
  timezone: row.timezone,
  scanEnabled: row.scanEnabled,
  scanTime: row.scanTime,
  extraScanIntervalMinutes: row.extraScanIntervalMinutes,
  aiMonthlyBudgetCents: row.aiMonthlyBudgetCents,
  maxMessageChars: row.maxMessageChars,
  maxAttachmentBytes: row.maxAttachmentBytes,
  notifyDailyDigest: row.notifyDailyDigest,
  notifyUrgentDeadlines: row.notifyUrgentDeadlines,
  notifyClarifications: row.notifyClarifications,
  quietHoursStart: row.quietHoursStart,
  quietHoursEnd: row.quietHoursEnd,
});

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

export type FieldVersions = Record<string, number>;
export type AddressJson = { name: string | null; address: string };
export type AttachmentJson = { filename: string | null; contentType: string | null; size: number | null; inline: boolean };
export type RunStats = {
  fetched: number;
  newMessages: number;
  updatedMessages: number;
  analyzed: number;
  tasksCreated: number;
  tasksUpdated: number;
  clarifications: number;
  skipped: number;
  budgetPaused: number;
  errors: number;
};
export type ClarificationOptionJson = { id: string; label: string; scope: "once" | "permanent" };

export const users = pgTable("users", {
  id: id(),
  appleSub: text("apple_sub").unique(),
  devEmail: text("dev_email").unique(),
  email: text("email"),
  displayName: text("display_name"),
  timezone: text("timezone").notNull().default("Europe/Paris"),
  scanEnabled: boolean("scan_enabled").notNull().default(true),
  scanTime: text("scan_time").notNull().default("07:00"),
  extraScanIntervalMinutes: integer("extra_scan_interval_minutes"),
  aiMonthlyBudgetCents: integer("ai_monthly_budget_cents").notNull().default(500),
  maxMessageChars: integer("max_message_chars").notNull().default(20000),
  maxAttachmentBytes: integer("max_attachment_bytes").notNull().default(5_000_000),
  notifyDailyDigest: boolean("notify_daily_digest").notNull().default(false),
  notifyUrgentDeadlines: boolean("notify_urgent_deadlines").notNull().default(false),
  notifyClarifications: boolean("notify_clarifications").notNull().default(false),
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),
  settingsVersion: integer("settings_version").notNull().default(1),
  lastScheduledScanOn: date("last_scheduled_scan_on", { mode: "string" }),
  lastExtraScanAt: ts("last_extra_scan_at"),
  lastDigestSentOn: date("last_digest_sent_on", { mode: "string" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    deviceName: text("device_name"),
    platform: text("platform"),
    devLogin: boolean("dev_login").notNull().default(false),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const pushDevices = pgTable("push_devices", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  environment: text("environment").notNull(),
  platform: text("platform").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  disabledAt: ts("disabled_at"),
});

export const oauthStates = pgTable("oauth_states", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  state: text("state").notNull().unique(),
  codeVerifier: text("code_verifier").notNull(),
  /** "read" or "mark": the access level requested, so the code is redeemed for the same scopes. */
  access: text("access").notNull().default("read"),
  accountId: uuid("account_id"),
  createdAt: createdAt(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    emailAddress: text("email_address").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").notNull().default("active"),
    credentialsEnc: text("credentials_enc"),
    imapHost: text("imap_host"),
    imapPort: integer("imap_port"),
    imapSecure: boolean("imap_secure"),
    imapUsername: text("imap_username"),
    capabilities: jsonb("capabilities"),
    markerStrategy: text("marker_strategy").notNull().default("none"),
    markerKeyword: text("marker_keyword"),
    markerFolder: text("marker_folder"),
    markerAcknowledged: boolean("marker_acknowledged").notNull().default(false),
    initialImportDays: integer("initial_import_days").notNull().default(14),
    includeSent: boolean("include_sent").notNull().default(true),
    lastSuccessfulFetchAt: ts("last_successful_fetch_at"),
    lastSuccessfulAnalysisAt: ts("last_successful_analysis_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAction: text("last_error_action"),
    lastErrorAt: ts("last_error_at"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    removedAt: ts("removed_at"),
  },
  (t) => [
    index("mail_accounts_user_idx").on(t.userId),
    uniqueIndex("mail_accounts_user_address_uq").on(t.userId, t.provider, sql`lower(${t.emailAddress})`).where(sql`${t.removedAt} is null`),
  ],
);

export const mailFolders = pgTable(
  "mail_folders",
  {
    id: id(),
    accountId: uuid("account_id").notNull().references(() => mailAccounts.id, { onDelete: "cascade" }),
    providerFolderId: text("provider_folder_id").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull().default("other"),
    selected: boolean("selected").notNull().default(false),
    imapUidValidity: bigint("imap_uidvalidity", { mode: "bigint" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("mail_folders_account_provider_uq").on(t.accountId, t.providerFolderId)],
);

export const threads = pgTable(
  "threads",
  {
    id: id(),
    accountId: uuid("account_id").notNull().references(() => mailAccounts.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id"),
    subjectKey: text("subject_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("threads_account_provider_uq").on(t.accountId, t.providerThreadId)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    accountId: uuid("account_id").notNull().references(() => mailAccounts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    /** Stable per account: provider id where immutable, else RFC Message-ID, else content fingerprint. */
    identityKey: text("identity_key").notNull(),
    providerMessageId: text("provider_message_id"),
    rfcMessageId: text("rfc_message_id"),
    inReplyTo: text("in_reply_to"),
    referencesIds: text("references_ids").array().notNull().default(sql`'{}'::text[]`),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    toAddresses: jsonb("to_addresses").$type<AddressJson[]>().notNull().default(sql`'[]'::jsonb`),
    ccAddresses: jsonb("cc_addresses").$type<AddressJson[]>().notNull().default(sql`'[]'::jsonb`),
    subject: text("subject"),
    sentAt: ts("sent_at"),
    receivedAt: ts("received_at"),
    language: text("language"),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    remoteContentBlocked: integer("remote_content_blocked").notNull().default(0),
    snippet: text("snippet"),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    attachments: jsonb("attachments").$type<AttachmentJson[]>().notNull().default(sql`'[]'::jsonb`),
    sizeBytes: integer("size_bytes"),
    contentHash: text("content_hash").notNull(),
    headersFingerprint: text("headers_fingerprint"),
    webLink: text("web_link"),
    isFromMe: boolean("is_from_me").notNull().default(false),
    analysisStatus: text("analysis_status").notNull().default("pending"),
    analysisContentHash: text("analysis_content_hash"),
    analysisAttempts: integer("analysis_attempts").notNull().default(0),
    analysisError: text("analysis_error"),
    analyzedAt: ts("analyzed_at"),
    markerStatus: text("marker_status").notNull().default("not_requested"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("messages_account_identity_uq").on(t.accountId, t.identityKey),
    index("messages_account_sent_idx").on(t.accountId, t.sentAt),
    index("messages_rfc_idx").on(t.accountId, t.rfcMessageId),
    index("messages_analysis_idx").on(t.analysisStatus),
    index("messages_thread_idx").on(t.threadId),
  ],
);

export const messageLocations = pgTable(
  "message_locations",
  {
    id: id(),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").notNull().references(() => mailFolders.id, { onDelete: "cascade" }),
    imapUidValidity: bigint("imap_uidvalidity", { mode: "bigint" }),
    imapUid: bigint("imap_uid", { mode: "bigint" }),
    providerLocationId: text("provider_location_id"),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    present: boolean("present").notNull().default(true),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    removedAt: ts("removed_at"),
  },
  (t) => [
    uniqueIndex("message_locations_message_folder_uq").on(t.messageId, t.folderId),
    uniqueIndex("message_locations_imap_uq")
      .on(t.folderId, t.imapUidValidity, t.imapUid)
      .where(sql`${t.imapUid} is not null`),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    /** Per-field version of the last change; used for field-level conflict detection. */
    fieldVersions: jsonb("field_versions").$type<FieldVersions>().notNull().default(sql`'{}'::jsonb`),
    origin: text("origin").notNull(),
    status: text("status").notNull().default("todo"),
    waiting: boolean("waiting").notNull().default(false),
    waitingCheckAt: date("waiting_check_at", { mode: "string" }),
    snoozedUntil: ts("snoozed_until"),
    plannedFor: date("planned_for", { mode: "string" }),
    sortKey: doublePrecision("sort_key"),
    aiTitle: text("ai_title"),
    aiNextStep: text("ai_next_step"),
    aiSummary: text("ai_summary"),
    aiPriority: text("ai_priority"),
    aiPriorityReason: text("ai_priority_reason"),
    aiDeadlineDate: date("ai_deadline_date", { mode: "string" }),
    aiDeadlineAt: ts("ai_deadline_at"),
    aiDeadlinePrecision: text("ai_deadline_precision"),
    aiDeadlineKind: text("ai_deadline_kind"),
    aiDeadlineQuote: text("ai_deadline_quote"),
    aiWhy: text("ai_why"),
    aiNeeds: text("ai_needs"),
    requiresAttachmentReading: boolean("requires_attachment_reading").notNull().default(false),
    manualTitle: text("manual_title"),
    manualNextStep: text("manual_next_step"),
    manualPriority: text("manual_priority"),
    manualDeadlineDate: date("manual_deadline_date", { mode: "string" }),
    manualDeadlineAt: ts("manual_deadline_at"),
    manualDeadlinePrecision: text("manual_deadline_precision"),
    manualDeadlineCleared: boolean("manual_deadline_cleared").notNull().default(false),
    estimatedMinutes: integer("estimated_minutes"),
    estimateSource: text("estimate_source"),
    latestChange: text("latest_change"),
    doneAt: ts("done_at"),
    dismissedAt: ts("dismissed_at"),
    dismissedReason: text("dismissed_reason"),
    statusBeforeDismiss: text("status_before_dismiss"),
    mergedIntoTaskId: uuid("merged_into_task_id"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tasks_user_status_idx").on(t.userId, t.status), index("tasks_user_updated_idx").on(t.userId, t.updatedAt)],
);

export const taskSources = pgTable(
  "task_sources",
  {
    id: id(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    addedBy: text("added_by").notNull(),
    /** Normalized action key; together with the message it makes AI task creation idempotent. */
    actionKey: text("action_key"),
    evidenceQuotes: jsonb("evidence_quotes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    changeSummary: text("change_summary"),
    createdAt: createdAt(),
    removedAt: ts("removed_at"),
  },
  (t) => [
    uniqueIndex("task_sources_task_message_uq").on(t.taskId, t.messageId),
    uniqueIndex("task_sources_message_action_uq")
      .on(t.messageId, t.actionKey)
      .where(sql`${t.actionKey} is not null and ${t.role} = 'origin'`),
    index("task_sources_message_idx").on(t.messageId),
  ],
);

export const taskNotes = pgTable(
  "task_notes",
  {
    id: id(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    version: integer("version").notNull().default(1),
    conflictOfNoteId: uuid("conflict_of_note_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("task_notes_task_idx").on(t.taskId)],
);

export const taskChecklistItems = pgTable(
  "task_checklist_items",
  {
    id: id(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    done: boolean("done").notNull().default(false),
    position: doublePrecision("position").notNull().default(0),
    source: text("source").notNull().default("user"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("task_checklist_task_idx").on(t.taskId)],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: id(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    actor: text("actor").notNull(),
    messageId: uuid("message_id"),
    summary: text("summary").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    createdAt: createdAt(),
  },
  (t) => [index("task_events_task_idx").on(t.taskId, t.createdAt)],
);

export const taskMerges = pgTable("task_merges", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceTaskId: uuid("source_task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  targetTaskId: uuid("target_task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  movedSourceIds: uuid("moved_source_ids").array().notNull().default(sql`'{}'::uuid[]`),
  movedNoteIds: uuid("moved_note_ids").array().notNull().default(sql`'{}'::uuid[]`),
  movedChecklistIds: uuid("moved_checklist_ids").array().notNull().default(sql`'{}'::uuid[]`),
  sourceStatusBefore: text("source_status_before").notNull(),
  createdAt: createdAt(),
  undoneAt: ts("undone_at"),
});

export const clarificationRequests = pgTable(
  "clarification_requests",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("open"),
    question: text("question").notNull(),
    reason: text("reason").notNull(),
    excerpt: text("excerpt"),
    subject: text("subject"),
    options: jsonb("options").$type<ClarificationOptionJson[]>().notNull(),
    allowFreeText: boolean("allow_free_text").notNull().default(true),
    /** Prevents asking the same thing twice (e.g. membership:b2). */
    dedupeKey: text("dedupe_key").notNull(),
    /** Analysis whose action(s) wait for this answer; actionIndex null means all held actions of the mail. */
    analysisId: uuid("analysis_id"),
    actionIndex: integer("action_index"),
    answerOptionId: text("answer_option_id"),
    answerText: text("answer_text"),
    answerScope: text("answer_scope"),
    answeredAt: ts("answered_at"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("clarifications_user_dedupe_uq").on(t.userId, t.dedupeKey), index("clarifications_user_status_idx").on(t.userId, t.status)],
);

export const userRules = pgTable(
  "user_rules",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    applies: boolean("applies").notNull(),
    note: text("note"),
    sourceClarificationId: uuid("source_clarification_id"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("user_rules_subject_uq").on(t.userId, t.kind, sql`lower(${t.subject})`).where(sql`${t.deletedAt} is null`),
  ],
);

export const syncCursors = pgTable(
  "sync_cursors",
  {
    id: id(),
    accountId: uuid("account_id").notNull().references(() => mailAccounts.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => mailFolders.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    cursor: text("cursor").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sync_cursors_uq").on(t.accountId, t.kind, sql`coalesce(${t.folderId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
  ],
);

export const processingRuns = pgTable(
  "processing_runs",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => mailAccounts.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("queued"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    stats: jsonb("stats").$type<RunStats>().notNull().default(
      sql`'{"fetched":0,"newMessages":0,"updatedMessages":0,"analyzed":0,"tasksCreated":0,"tasksUpdated":0,"clarifications":0,"skipped":0,"budgetPaused":0,"errors":0}'::jsonb`,
    ),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("processing_runs_user_idx").on(t.userId, t.createdAt)],
);

export const messageAnalyses = pgTable(
  "message_analyses",
  {
    id: id(),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text("status").notNull(),
    output: jsonb("output"),
    error: text("error"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    /** Guardrail corrections applied to the model output, for traceability. */
    adjustments: jsonb("adjustments").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("message_analyses_user_month_idx").on(t.userId, t.createdAt), index("message_analyses_message_idx").on(t.messageId)],
);

export const markerOperations = pgTable(
  "marker_operations",
  {
    id: id(),
    accountId: uuid("account_id").notNull().references(() => mailAccounts.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    taskId: uuid("task_id"),
    operation: text("operation").notNull(),
    strategy: text("strategy").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("marker_operations_uq").on(t.messageId, t.strategy, t.operation)],
);

export const mutationReceipts = pgTable(
  "mutation_receipts",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mutation_receipts_uq").on(t.userId, t.idempotencyKey)],
);

export const changeLog = pgTable(
  "change_log",
  {
    seq: bigserial("seq", { mode: "bigint" }).primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    op: text("op").notNull(),
    version: integer("version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("change_log_user_seq_idx").on(t.userId, t.seq)],
);

export const notificationsSent = pgTable(
  "notifications_sent",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    /** sent · skipped (e.g. no APNs configured, no device) · failed */
    status: text("status").notNull().default("sent"),
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notifications_sent_uq").on(t.userId, t.dedupeKey)],
);

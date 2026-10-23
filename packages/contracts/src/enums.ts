import { z } from "zod";

export const TaskStatus = z.enum(["todo", "doing", "done", "dismissed"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Priority = z.enum(["critical", "important", "can_wait"]);
export type Priority = z.infer<typeof Priority>;

/** How exactly a deadline is known. "date" = day only, never invent a time or zone. */
export const DeadlinePrecision = z.enum(["date", "datetime"]);
export type DeadlinePrecision = z.infer<typeof DeadlinePrecision>;

/** explicit = stated in the mail, uncertain = interpreted, suggested = proposed working date (not a real deadline). */
export const DeadlineKind = z.enum(["explicit", "uncertain", "suggested"]);
export type DeadlineKind = z.infer<typeof DeadlineKind>;

export const Relevance = z.enum(["actionable", "informational", "uncertain"]);
export type Relevance = z.infer<typeof Relevance>;

export const Provider = z.enum(["gmail", "microsoft", "imap"]);
export type Provider = z.infer<typeof Provider>;

export const AccountStatus = z.enum(["active", "paused", "error", "needs_reauth", "removed"]);
export type AccountStatus = z.infer<typeof AccountStatus>;

/**
 * Visible marking strategies. None of them is guaranteed to be visible in Apple Mail;
 * each account reports what its server supports (see AccountCapabilities).
 */
export const MarkerStrategy = z.enum([
  "none",
  "imap_keyword",
  "imap_flagged",
  "imap_copy_folder",
  "gmail_label",
  "graph_category",
  "graph_flag",
]);
export type MarkerStrategy = z.infer<typeof MarkerStrategy>;

export const MarkerStatus = z.enum(["not_requested", "pending", "applied", "failed", "unsupported", "cleared"]);
export type MarkerStatus = z.infer<typeof MarkerStatus>;

export const FolderRole = z.enum(["inbox", "sent", "archive", "drafts", "spam", "trash", "other"]);
export type FolderRole = z.infer<typeof FolderRole>;

export const AnalysisStatus = z.enum([
  "pending",
  "analyzed",
  "skipped",
  "failed",
  "budget_paused",
  "too_large",
]);
export type AnalysisStatus = z.infer<typeof AnalysisStatus>;

export const ClarificationKind = z.enum([
  "relevance",
  "membership",
  "responsibility",
  "merge",
  "deadline_conflict",
  "reopen",
  "other",
]);
export type ClarificationKind = z.infer<typeof ClarificationKind>;

export const ClarificationStatus = z.enum(["open", "answered", "dismissed"]);
export type ClarificationStatus = z.infer<typeof ClarificationStatus>;

/** "once" never creates a rule; "permanent" stores a visible, editable user rule. */
export const AnswerScope = z.enum(["once", "permanent"]);
export type AnswerScope = z.infer<typeof AnswerScope>;

export const TaskOrigin = z.enum(["ai", "manual", "mail_manual"]);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

export const EstimateSource = z.enum(["user", "estimate"]);
export type EstimateSource = z.infer<typeof EstimateSource>;

export const SyncEntityType = z.enum([
  "task",
  "note",
  "checklist_item",
  "clarification",
  "account",
  "rule",
  "settings",
]);
export type SyncEntityType = z.infer<typeof SyncEntityType>;

export const TaskEventKind = z.enum([
  "created_auto",
  "created_manual",
  "source_added",
  "source_removed",
  "ai_updated",
  "deadline_changed",
  "priority_changed",
  "title_changed",
  "status_changed",
  "waiting_changed",
  "snoozed",
  "note_added",
  "note_conflict",
  "merged",
  "unmerged",
  "dismissed",
  "restored",
  "correction",
  "reply_received",
  "own_reply",
  "follow_up_created",
]);
export type TaskEventKind = z.infer<typeof TaskEventKind>;

export const RunKind = z.enum(["scan", "analysis"]);
export const RunTrigger = z.enum(["schedule", "manual", "retry", "onboarding"]);
export const RunStatus = z.enum(["queued", "running", "succeeded", "partial", "failed"]);
export type RunStatus = z.infer<typeof RunStatus>;

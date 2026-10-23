import { z } from "zod";
import { DeadlineKind, Priority, Relevance } from "./enums.js";

/**
 * Structured output the language model must return for one message (with its context).
 * Validated server-side; anything that does not parse is retried once, then the message is
 * marked as failed – never silently treated as "no task".
 */
export const AnalysisAction = z.object({
  action_title_de: z.string().min(3).max(200).describe("Konkrete Aufgabe mit Verb, z. B. „Studienbescheinigung schicken“"),
  next_step_de: z.string().min(3).max(500),
  priority: Priority,
  priority_reason_de: z.string().min(3).max(300),
  deadline: z
    .string()
    .nullable()
    .describe("YYYY-MM-DD for date-only deadlines, full ISO 8601 with offset only when the mail states a time"),
  deadline_precision: z.enum(["date", "datetime", "none"]),
  deadline_kind: DeadlineKind.nullable(),
  deadline_source_quote: z.string().max(500).nullable(),
  source_message_ids: z.array(z.string()).min(1),
  evidence_quotes: z.array(z.string().max(500)).max(5),
  why_de: z.string().min(3).max(400).describe("Warum betrifft es mich?"),
  needs_de: z.string().max(400).nullable().describe("Was brauche ich dafür?"),
  checklist_de: z.array(z.string().min(2).max(200)).max(10).describe("Only when the mail itself asks for several steps"),
  requires_attachment_reading: z.boolean(),
  uncertainty_reason: z.string().max(400).nullable(),
  clarification_question: z.string().max(300).nullable(),
  suggested_existing_task_id: z.string().nullable(),
  update_summary_de: z
    .string()
    .max(300)
    .nullable()
    .describe("For updates of an existing task: what changed, e.g. „Frist von Freitag auf Montag verschoben“"),
});
export type AnalysisAction = z.infer<typeof AnalysisAction>;

export const AnalysisClarification = z.object({
  kind: z.enum(["relevance", "membership", "responsibility", "merge", "deadline_conflict", "other"]),
  question_de: z.string().min(3).max(300),
  reason_de: z.string().min(3).max(300),
  excerpt: z.string().max(600).nullable(),
  subject: z.string().max(120).nullable().describe("e.g. the group name for membership questions"),
  options: z
    .array(z.object({ id: z.string().min(1).max(40), label_de: z.string().min(1).max(80), may_be_permanent: z.boolean() }))
    .min(2)
    .max(4),
  related_action_index: z.number().int().nullable(),
});
export type AnalysisClarification = z.infer<typeof AnalysisClarification>;

export const AnalysisOutput = z.object({
  relevance: Relevance,
  language: z.string().min(2).max(10).describe("Detected language code, e.g. fr"),
  summary_de: z.string().min(3).max(1200),
  actions: z.array(AnalysisAction).max(8),
  clarifications: z.array(AnalysisClarification).max(3),
  uncertainty_reason: z.string().max(400).nullable(),
  own_reply_detected: z.boolean().describe("The newest message was written by the user"),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;

import { z } from "zod";

/**
 * Schema sent to the model as structured output. Same shape as the AnalysisOutput contract,
 * but without length limits: the API does not enforce them, and an over-long field must lead
 * to clamping by the guardrails rather than to a failed analysis. The strict contract schema
 * validates the normalized result afterwards.
 */
const Priority = z.enum(["critical", "important", "can_wait"]);

export const WireAction = z.object({
  action_title_de: z.string().describe("Kurze Aufgabe mit Verb, z. B. „Studienbescheinigung an Claire schicken“"),
  next_step_de: z.string().describe("Der konkrete nächste Schritt"),
  priority: Priority,
  priority_reason_de: z.string().describe("Ein kurzer Satz"),
  deadline: z.string().nullable().describe("YYYY-MM-DD; nur wenn die Mail eine Uhrzeit mit bestimmbarer Zeitzone nennt: ISO 8601 mit Offset"),
  deadline_precision: z.enum(["date", "datetime", "none"]),
  deadline_kind: z.enum(["explicit", "uncertain", "suggested"]).nullable(),
  deadline_source_quote: z.string().nullable().describe("Wörtliches Zitat aus der Mail, das die Frist belegt"),
  source_message_ids: z.array(z.string()),
  evidence_quotes: z.array(z.string()).describe("Wörtliche kurze Zitate aus der Mail"),
  why_de: z.string().describe("Warum betrifft es mich?"),
  needs_de: z.string().nullable().describe("Was brauche ich dafür? Nur Genanntes"),
  checklist_de: z.array(z.string()),
  requires_attachment_reading: z.boolean(),
  uncertainty_reason: z.string().nullable(),
  clarification_question: z.string().nullable(),
  suggested_existing_task_id: z.string().nullable(),
  update_summary_de: z.string().nullable(),
});

export const WireClarification = z.object({
  kind: z.enum(["relevance", "membership", "responsibility", "merge", "deadline_conflict", "other"]),
  question_de: z.string(),
  reason_de: z.string(),
  excerpt: z.string().nullable().describe("Wörtlicher relevanter Mailausschnitt"),
  subject: z.string().nullable(),
  options: z.array(z.object({ id: z.string(), label_de: z.string(), may_be_permanent: z.boolean() })),
  related_action_index: z.number().int().nullable(),
});

export const WireOutput = z.object({
  relevance: z.enum(["actionable", "informational", "uncertain"]),
  language: z.string().describe("ISO-639-1-Sprachcode der aktuellen Mail"),
  summary_de: z.string(),
  actions: z.array(WireAction),
  clarifications: z.array(WireClarification),
  uncertainty_reason: z.string().nullable(),
  own_reply_detected: z.boolean(),
});
export type WireOutput = z.infer<typeof WireOutput>;

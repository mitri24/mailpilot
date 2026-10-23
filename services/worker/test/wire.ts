import type { WireOutput } from "@mailpilot/ai";

type WireAction = WireOutput["actions"][number];
type WireClarification = WireOutput["clarifications"][number];

/** Builders for fixture model outputs; tests state only what matters for the case. */
export const act = (over: Partial<WireAction> & Pick<WireAction, "action_title_de">): WireAction => ({
  next_step_de: over.action_title_de,
  priority: "important",
  priority_reason_de: "Relevante Aufgabe.",
  deadline: null,
  deadline_precision: "none",
  deadline_kind: null,
  deadline_source_quote: null,
  source_message_ids: [],
  evidence_quotes: [],
  why_de: "Du bist direkt adressiert.",
  needs_de: null,
  checklist_de: [],
  requires_attachment_reading: false,
  uncertainty_reason: null,
  clarification_question: null,
  suggested_existing_task_id: null,
  update_summary_de: null,
  ...over,
});

export const clar = (over: Partial<WireClarification> & Pick<WireClarification, "kind" | "question_de">): WireClarification => ({
  reason_de: "Die Information fehlt.",
  excerpt: null,
  subject: null,
  options: [],
  related_action_index: null,
  ...over,
});

export const out = (over: Partial<WireOutput> = {}): WireOutput => ({
  relevance: "actionable",
  language: "de",
  summary_de: "Zusammenfassung der Mail.",
  actions: [],
  clarifications: [],
  uncertainty_reason: null,
  own_reply_detected: false,
  ...over,
});

import type { AnalysisInput, WireOutput } from "../src/index.js";

export const baseInput = (over: Partial<AnalysisInput> = {}, text = "Bonjour, merci de m'envoyer votre attestation de scolarité avant vendredi 24 octobre. Cordialement, Claire"): AnalysisInput => ({
  today: "2026-10-21",
  timeZone: "Europe/Paris",
  ownAddresses: ["ich@uni.example"],
  displayName: null,
  message: {
    id: "m-1",
    from: { name: "Claire Dubois", address: "claire.dubois@universite.example" },
    to: [{ name: null, address: "ich@uni.example" }],
    cc: [],
    subject: "Attestation de scolarité",
    sentAt: "2026-10-20T09:12:00+02:00",
    isFromMe: false,
    text,
    quotedContext: null,
    truncated: false,
    attachments: [],
  },
  thread: [],
  candidateTasks: [],
  facts: [],
  askedQuestions: [],
  ...over,
});

export const action = (over: Partial<WireOutput["actions"][number]> = {}): WireOutput["actions"][number] => ({
  action_title_de: "Studienbescheinigung an Claire schicken",
  next_step_de: "Studienbescheinigung herunterladen und an Claire senden",
  priority: "important",
  priority_reason_de: "Frist am Freitag.",
  deadline: "2026-10-24",
  deadline_precision: "date",
  deadline_kind: "explicit",
  deadline_source_quote: "avant vendredi 24 octobre",
  source_message_ids: ["m-1"],
  evidence_quotes: ["merci de m'envoyer votre attestation de scolarité"],
  why_de: "Du bist direkt adressiert und wirst um die Bescheinigung gebeten.",
  needs_de: "Studienbescheinigung",
  checklist_de: [],
  requires_attachment_reading: false,
  uncertainty_reason: null,
  clarification_question: null,
  suggested_existing_task_id: null,
  update_summary_de: null,
  ...over,
});

export const wire = (over: Partial<WireOutput> = {}): WireOutput => ({
  relevance: "actionable",
  language: "fr",
  summary_de: "Claire bittet um deine Studienbescheinigung bis Freitag, 24. Oktober.",
  actions: [action()],
  clarifications: [],
  uncertainty_reason: null,
  own_reply_detected: false,
  ...over,
});

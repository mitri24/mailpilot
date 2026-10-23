import { AnalysisOutput, type AnalysisAction, type AnalysisClarification, type Priority } from "@mailpilot/contracts";
import type { AnalysisInput, KnownFact } from "./types.js";
import type { WireOutput } from "./wire.js";

type WireAction = WireOutput["actions"][number];
type WireClarification = WireOutput["clarifications"][number];

/** Canonical answer options; rules are only ever derived from "yes"/"no" with an explicit permanent scope. */
const OPTION_SETS: Record<string, Array<{ id: string; label_de: string; may_be_permanent: boolean }>> = {
  membership: [
    { id: "yes", label_de: "Ja", may_be_permanent: true },
    { id: "no", label_de: "Nein", may_be_permanent: true },
    { id: "not_this_time", label_de: "Diesmal nicht", may_be_permanent: false },
    { id: "later", label_de: "Weiß ich noch nicht", may_be_permanent: false },
  ],
  relevance: [
    { id: "yes", label_de: "Betrifft mich", may_be_permanent: true },
    { id: "no", label_de: "Betrifft mich nicht", may_be_permanent: true },
    { id: "not_this_time", label_de: "Diesmal nicht", may_be_permanent: false },
    { id: "later", label_de: "Später entscheiden", may_be_permanent: false },
  ],
  responsibility: [
    { id: "yes", label_de: "Bin zuständig", may_be_permanent: true },
    { id: "no", label_de: "Bin nicht zuständig", may_be_permanent: true },
    { id: "not_this_time", label_de: "Diesmal nicht", may_be_permanent: false },
    { id: "later", label_de: "Weiß ich noch nicht", may_be_permanent: false },
  ],
  merge: [
    { id: "merge", label_de: "Zur bestehenden Aufgabe", may_be_permanent: false },
    { id: "separate", label_de: "Eigene Aufgabe", may_be_permanent: false },
    { id: "later", label_de: "Später entscheiden", may_be_permanent: false },
  ],
};
const LATER = { id: "later", label_de: "Weiß ich noch nicht", may_be_permanent: false };

const FACT_KIND: Record<string, KnownFact["kind"] | undefined> = {
  membership: "membership",
  responsibility: "responsibility",
  relevance: "sender_relevance",
};

const squash = (s: string) =>
  s
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const clamp = (s: string, max: number) => {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const clampOrNull = (s: string | null, max: number) => {
  if (s === null) return null;
  const t = clamp(s, max);
  return t.length > 0 ? t : null;
};
const atLeast = (s: string, min: number, fallback: string) => (s.length >= min ? s : fallback);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const TIME_IN_TEXT = /\b\d{1,2}\s?([:.h]\s?\d{2}|uhr|h\b|am\b|pm\b)/i;

function isCalendarDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export interface NormalizeResult {
  output: AnalysisOutput;
  adjustments: string[];
}

/**
 * Guardrails between the model and the database: nothing unverifiable becomes a fact.
 * Quotes must occur in the mail, deadlines need a verbatim source and no invented time,
 * informational mails yield no tasks and answered assignments are not asked again.
 */
export function normalizeOutput(raw: WireOutput, input: AnalysisInput): NormalizeResult {
  const adjustments: string[] = [];
  const m = input.message;
  const body = squash(m.text);
  const haystack = `${squash(m.subject ?? "")}\n${body}`;
  const found = (quote: string | null | undefined, where = haystack) => {
    if (!quote) return false;
    const q = squash(quote);
    return q.length >= 3 && where.includes(q);
  };
  const knownIds = new Set([m.id, ...input.thread.map((t) => t.id)]);
  const candidateIds = new Set(input.candidateTasks.map((t) => t.id));

  // ---- actions (indices are remapped for clarifications below)
  const indexMap = new Map<number, number>();
  const actions: AnalysisAction[] = [];
  raw.actions.slice(0, 8).forEach((a, i) => {
    const action = normalizeAction(a, input, found, knownIds, candidateIds, adjustments);
    if (!action) return;
    indexMap.set(i, actions.length);
    actions.push(action);
  });

  let relevance = raw.relevance;
  if (relevance === "informational" && actions.length > 0) {
    adjustments.push("Informationsmail: vorgeschlagene Aufgaben verworfen");
    actions.length = 0;
    indexMap.clear();
  }

  // ---- clarifications
  const dropped = new Set<number>();
  let resolvedByFact = false;
  const clarifications: AnalysisClarification[] = [];
  for (const c of raw.clarifications) {
    const mapped = c.related_action_index === null ? null : (indexMap.get(c.related_action_index) ?? -1);
    if (mapped === -1) continue; // refers to an action that did not survive
    const fact = matchingFact(c, input.facts);
    if (fact) {
      adjustments.push(`Rückfrage entfällt: dauerhafte Zuordnung „${fact.subject}“ ist bekannt`);
      if (fact.applies) resolvedByFact = true;
      if (!fact.applies) {
        if (mapped === null) actions.forEach((_, idx) => dropped.add(idx));
        else dropped.add(mapped);
      }
      continue;
    }
    const normalized = normalizeClarification(c, mapped, found, adjustments);
    if (normalized && clarifications.length < 3) clarifications.push(normalized);
  }

  // An uncertain mail never turns into a claimed obligation without a question,
  // unless a confirmed assignment already settled exactly that uncertainty.
  const holds = clarifications.some((c) => c.kind === "relevance" || c.kind === "membership" || c.kind === "responsibility");
  if (relevance === "uncertain" && resolvedByFact && !holds && actions.length > 0) {
    relevance = "actionable";
    adjustments.push("Unklarheit durch deine dauerhafte Zuordnung geklärt");
  }
  if (relevance === "uncertain" && actions.length > 0 && !holds && clarifications.length < 3) {
    adjustments.push("Unklare Relevanz: Rückfrage ergänzt");
    const excerpt = actions[0]?.evidence_quotes[0] ?? null;
    clarifications.push({
      kind: "relevance",
      question_de: "Betrifft dich diese Mail?",
      reason_de: clamp(raw.uncertainty_reason ?? "Es ist unklar, ob die Mail eine Aufgabe für dich enthält.", 300),
      excerpt,
      subject: m.from?.address ?? null,
      options: OPTION_SETS.relevance!,
      related_action_index: null,
    });
  }

  let finalActions = actions;
  if (dropped.size > 0) {
    // Remove actions that a known assignment rules out and shift clarification indices.
    const keep = actions.map((_, i) => !dropped.has(i));
    const shift = new Map<number, number>();
    finalActions = [];
    actions.forEach((a, i) => {
      if (keep[i]) {
        shift.set(i, finalActions.length);
        finalActions.push(a);
      }
    });
    for (const c of clarifications) {
      if (c.related_action_index !== null) c.related_action_index = shift.get(c.related_action_index) ?? null;
    }
    adjustments.push("Aufgaben entfernt, die laut deiner Zuordnung nicht dich betreffen");
    if (finalActions.length === 0 && relevance === "actionable") relevance = "informational";
  }

  const output = AnalysisOutput.parse({
    relevance,
    language: clamp(raw.language || "und", 10).toLowerCase(),
    summary_de: atLeast(clamp(raw.summary_de, 1200), 3, "Keine Zusammenfassung erhalten."),
    actions: finalActions,
    clarifications,
    uncertainty_reason: clampOrNull(raw.uncertainty_reason, 400),
    own_reply_detected: raw.own_reply_detected || m.isFromMe,
  });
  return { output, adjustments };
}

function normalizeAction(
  a: WireAction,
  input: AnalysisInput,
  found: (quote: string | null | undefined, where?: string) => boolean,
  knownIds: Set<string>,
  candidateIds: Set<string>,
  adjustments: string[],
): AnalysisAction | null {
  const title = clamp(a.action_title_de, 200);
  if (title.length < 3) {
    adjustments.push("Aufgabe ohne Titel verworfen");
    return null;
  }
  const evidence = a.evidence_quotes.filter((q) => found(q)).map((q) => clamp(q, 500)).slice(0, 5);
  if (evidence.length < a.evidence_quotes.length) adjustments.push("Nicht wörtlich belegte Zitate entfernt");

  const deadline = normalizeDeadline(a, found, adjustments);
  let priority: Priority = a.priority;
  let reason = atLeast(clamp(a.priority_reason_de, 300), 3, "Ohne Begründung eingestuft.");
  if (priority === "critical") {
    const near =
      deadline.value !== null && deadline.kind !== "suggested" && deadline.value.slice(0, 10) <= addDays(input.today, 7);
    const body = squash(input.message.text);
    const bodyEvidence = evidence.some((q) => found(q, body));
    if (!near && !bodyEvidence) {
      priority = "important";
      reason = clamp(`${reason} (Kritisch nur bei belegter Dringlichkeit.)`, 300);
      adjustments.push("Priorität kritisch ohne Beleg auf wichtig gesenkt");
    }
  }

  const sources = a.source_message_ids.filter((id) => knownIds.has(id));
  const checklist = a.checklist_de.map((s) => clamp(s, 200)).filter((s) => s.length >= 2).slice(0, 10);
  const suggested = a.suggested_existing_task_id && candidateIds.has(a.suggested_existing_task_id) ? a.suggested_existing_task_id : null;
  if (a.suggested_existing_task_id && !suggested) adjustments.push("Unbekannte bestehende Aufgabe ignoriert");

  return {
    action_title_de: title,
    next_step_de: atLeast(clamp(a.next_step_de, 500), 3, title),
    priority,
    priority_reason_de: reason,
    deadline: deadline.value,
    deadline_precision: deadline.precision,
    deadline_kind: deadline.kind,
    deadline_source_quote: deadline.quote,
    source_message_ids: sources.includes(input.message.id) ? sources : [input.message.id, ...sources],
    evidence_quotes: evidence,
    why_de: atLeast(clamp(a.why_de, 400), 3, "Aus der Mail abgeleitet."),
    needs_de: clampOrNull(a.needs_de, 400),
    checklist_de: checklist.length >= 2 ? checklist : [],
    requires_attachment_reading: a.requires_attachment_reading,
    uncertainty_reason: clampOrNull(a.uncertainty_reason, 400),
    clarification_question: clampOrNull(a.clarification_question, 300),
    suggested_existing_task_id: suggested,
    update_summary_de: clampOrNull(a.update_summary_de, 300),
  };
}

function normalizeDeadline(
  a: WireAction,
  found: (quote: string | null | undefined) => boolean,
  adjustments: string[],
): { value: string | null; precision: "date" | "datetime" | "none"; kind: AnalysisAction["deadline_kind"]; quote: string | null } {
  const none = { value: null, precision: "none" as const, kind: null, quote: null };
  if (!a.deadline || a.deadline_precision === "none") return none;
  let value = a.deadline.trim();
  let precision: "date" | "datetime" = a.deadline_precision;
  const quote = a.deadline_source_quote ? clamp(a.deadline_source_quote, 500) : null;

  if (precision === "datetime") {
    const statedTime = quote !== null && TIME_IN_TEXT.test(quote);
    if (!DATETIME_WITH_OFFSET.test(value) || !statedTime) {
      // No invented time or time zone: keep the calendar date only.
      precision = "date";
      value = value.slice(0, 10);
      adjustments.push("Uhrzeit ohne Beleg oder Zeitzone entfernt");
    }
  } else {
    value = value.slice(0, 10);
  }
  if (!isCalendarDate(value.slice(0, 10))) {
    adjustments.push("Ungültiges Fristdatum verworfen");
    return none;
  }
  let kind = a.deadline_kind ?? "uncertain";
  let verifiedQuote = quote;
  if (kind !== "suggested" && !found(quote)) {
    kind = "uncertain";
    verifiedQuote = null;
    adjustments.push("Frist ohne wörtlichen Beleg als unsicher markiert");
  }
  return { value, precision, kind, quote: verifiedQuote };
}

function matchingFact(c: WireClarification, facts: KnownFact[]): KnownFact | undefined {
  const kind = FACT_KIND[c.kind];
  if (!kind || !c.subject) return undefined;
  const subject = c.subject.trim().toLowerCase();
  return facts.find((f) => f.kind === kind && f.subject.trim().toLowerCase() === subject);
}

function normalizeClarification(
  c: WireClarification,
  relatedActionIndex: number | null,
  found: (quote: string | null | undefined) => boolean,
  adjustments: string[],
): AnalysisClarification | null {
  const question = clamp(c.question_de, 300);
  if (question.length < 3) return null;
  let excerpt = c.excerpt ? clamp(c.excerpt, 600) : null;
  if (excerpt && !found(excerpt)) {
    excerpt = null;
    adjustments.push("Nicht wörtlicher Mailausschnitt der Rückfrage entfernt");
  }
  const canonical = OPTION_SETS[c.kind];
  let options = canonical ?? c.options.slice(0, 3).map((o) => ({ id: clamp(o.id, 40), label_de: clamp(o.label_de, 80), may_be_permanent: false }));
  if (!canonical && !options.some((o) => o.id === "later")) options = [...options.slice(0, 3), LATER];
  if (options.length < 2) options = [{ id: "ok", label_de: "Verstanden", may_be_permanent: false }, LATER];
  return {
    kind: c.kind,
    question_de: question,
    reason_de: atLeast(clamp(c.reason_de, 300), 3, "Die Information fehlt in der Mail."),
    excerpt,
    subject: clampOrNull(c.subject, 120),
    options,
    related_action_index: relatedActionIndex,
  };
}

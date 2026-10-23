import { describe, expect, it } from "vitest";
import { normalizeOutput } from "../src/index.js";
import { action, baseInput, wire } from "./fixtures.js";

describe("guardrails", () => {
  it("keeps a verified explicit date deadline", () => {
    const { output, adjustments } = normalizeOutput(wire(), baseInput());
    expect(output.actions[0]).toMatchObject({ deadline: "2026-10-24", deadline_precision: "date", deadline_kind: "explicit" });
    expect(adjustments).toEqual([]);
  });

  it("marks a deadline without verbatim source as uncertain", () => {
    const { output } = normalizeOutput(wire({ actions: [action({ deadline_source_quote: "bis Freitag" })] }), baseInput());
    expect(output.actions[0]).toMatchObject({ deadline_kind: "uncertain", deadline_source_quote: null, deadline: "2026-10-24" });
  });

  it("never invents a time or time zone", () => {
    const noOffset = normalizeOutput(wire({ actions: [action({ deadline: "2026-10-24T14:00:00", deadline_precision: "datetime" })] }), baseInput());
    expect(noOffset.output.actions[0]).toMatchObject({ deadline: "2026-10-24", deadline_precision: "date" });
    const noTimeInQuote = normalizeOutput(wire({ actions: [action({ deadline: "2026-10-24T14:00:00+02:00", deadline_precision: "datetime" })] }), baseInput());
    expect(noTimeInQuote.output.actions[0]?.deadline_precision).toBe("date");
    const stated = normalizeOutput(
      wire({ actions: [action({ deadline: "2026-10-24T14:00:00+02:00", deadline_precision: "datetime", deadline_source_quote: "avant 14h00 vendredi" })] }),
      baseInput({}, "Merci d'envoyer le dossier avant 14h00 vendredi (heure de Paris)."),
    );
    expect(stated.output.actions[0]).toMatchObject({ deadline: "2026-10-24T14:00:00+02:00", deadline_precision: "datetime" });
  });

  it("drops invalid calendar dates", () => {
    const { output } = normalizeOutput(wire({ actions: [action({ deadline: "2026-02-30" })] }), baseInput());
    expect(output.actions[0]).toMatchObject({ deadline: null, deadline_precision: "none", deadline_kind: null });
  });

  it("removes quotes that are not in the mail and fixes source ids", () => {
    const { output } = normalizeOutput(
      wire({ actions: [action({ evidence_quotes: ["merci de m'envoyer", "erfundenes Zitat"], source_message_ids: ["unknown"] })] }),
      baseInput(),
    );
    expect(output.actions[0]?.evidence_quotes).toEqual(["merci de m'envoyer"]);
    expect(output.actions[0]?.source_message_ids).toEqual(["m-1"]);
  });

  it("informational mails never produce tasks", () => {
    const { output } = normalizeOutput(wire({ relevance: "informational" }), baseInput());
    expect(output.actions).toEqual([]);
  });

  it("urgent in the subject alone is not critical", () => {
    const input = baseInput({}, "Hallo, anbei der Newsletter.");
    input.message.subject = "URGENT: Newsletter";
    const { output } = normalizeOutput(
      wire({ actions: [action({ priority: "critical", deadline: null, deadline_precision: "none", deadline_kind: null, deadline_source_quote: null, evidence_quotes: ["URGENT"] })] }),
      input,
    );
    expect(output.actions[0]?.priority).toBe("important");
  });

  it("a critical task with a near evidenced deadline stays critical", () => {
    const { output } = normalizeOutput(wire({ actions: [action({ priority: "critical" })] }), baseInput());
    expect(output.actions[0]?.priority).toBe("critical");
  });

  it("asks instead of claiming an obligation when relevance is unclear", () => {
    const { output } = normalizeOutput(wire({ relevance: "uncertain", uncertainty_reason: "Rundmail an viele Gruppen." }), baseInput());
    expect(output.clarifications).toHaveLength(1);
    expect(output.clarifications[0]).toMatchObject({ kind: "relevance", related_action_index: null });
    expect(output.clarifications[0]?.options.map((o) => o.id)).toEqual(["yes", "no", "not_this_time", "later"]);
  });

  it("uses canonical options and verbatim excerpts", () => {
    const { output } = normalizeOutput(
      wire({
        clarifications: [
          {
            kind: "membership",
            question_de: "Gehörst du zur Gruppe B2?",
            reason_de: "Die Mail richtet sich an B2.",
            excerpt: "Nicht im Text",
            subject: "B2",
            options: [{ id: "a", label_de: "Vielleicht", may_be_permanent: true }],
            related_action_index: 0,
          },
        ],
      }),
      baseInput(),
    );
    const c = output.clarifications[0]!;
    expect(c.options.map((o) => o.label_de)).toEqual(["Ja", "Nein", "Diesmal nicht", "Weiß ich noch nicht"]);
    expect(c.excerpt).toBeNull();
    expect(c.related_action_index).toBe(0);
  });

  it("does not ask again what a permanent assignment answers", () => {
    const clar = {
      kind: "membership" as const,
      question_de: "Gehörst du zur Gruppe B2?",
      reason_de: "Die Mail richtet sich an B2.",
      excerpt: null,
      subject: "B2",
      options: [],
      related_action_index: 0,
    };
    const member = normalizeOutput(wire({ clarifications: [clar] }), baseInput({ facts: [{ kind: "membership", subject: "b2", applies: true }] }));
    expect(member.output.clarifications).toEqual([]);
    expect(member.output.actions).toHaveLength(1);
    const settled = normalizeOutput(wire({ relevance: "uncertain", clarifications: [clar] }), baseInput({ facts: [{ kind: "membership", subject: "B2", applies: true }] }));
    expect(settled.output.clarifications).toEqual([]);
    expect(settled.output.relevance).toBe("actionable");
    const notMember = normalizeOutput(wire({ clarifications: [clar] }), baseInput({ facts: [{ kind: "membership", subject: "B2", applies: false }] }));
    expect(notMember.output.actions).toEqual([]);
    expect(notMember.output.relevance).toBe("informational");
  });

  it("ignores suggested tasks that were not offered as candidates", () => {
    const { output } = normalizeOutput(wire({ actions: [action({ suggested_existing_task_id: "not-a-candidate" })] }), baseInput());
    expect(output.actions[0]?.suggested_existing_task_id).toBeNull();
    const withCandidate = normalizeOutput(
      wire({ actions: [action({ suggested_existing_task_id: "t-1" })] }),
      baseInput({ candidateTasks: [{ id: "t-1", title: "x", status: "todo", waiting: false, deadline: null, summary: null, sameThread: true }] }),
    );
    expect(withCandidate.output.actions[0]?.suggested_existing_task_id).toBe("t-1");
  });

  it("keeps a checklist only for several real steps and clamps long text", () => {
    const one = normalizeOutput(wire({ actions: [action({ checklist_de: ["Nur ein Schritt"] })] }), baseInput());
    expect(one.output.actions[0]?.checklist_de).toEqual([]);
    const long = normalizeOutput(wire({ actions: [action({ action_title_de: "x".repeat(400), checklist_de: ["Formular ausfüllen", "Unterschreiben"] })] }), baseInput());
    expect(long.output.actions[0]?.action_title_de.length).toBe(200);
    expect(long.output.actions[0]?.checklist_de).toHaveLength(2);
  });
});

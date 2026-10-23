import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@mailpilot/database";
import { ConnectorError } from "@mailpilot/mail-connectors";
import { FakeMailbox } from "./fake-mailbox.js";
import { createHarness, imapCaps, runScan, selectDefaultFolders, type Harness } from "./harness.js";
import { act, clar, out } from "./wire.js";

const { tasks, taskSources, taskEvents, messages, markerOperations, clarificationRequests, mailAccounts, messageAnalyses, taskChecklistItems } = schema;

describe("worker pipeline", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  async function setup(markerOver: Partial<typeof schema.mailAccounts.$inferInsert> = {}) {
    const user = await h.createUser();
    const box = new FakeMailbox(imapCaps());
    const account = await h.createAccount(user.id, box, markerOver);
    await selectDefaultFolders(h, account);
    return { user, box, account };
  }

  const tasksOf = (userId: string) => h.handle.db.select().from(tasks).where(eq(tasks.userId, userId));

  it("a French university mail becomes a German task with evidenced deadline and a marker", async () => {
    const { user, box, account } = await setup({ markerStrategy: "imap_keyword", markerKeyword: "MailPilot", markerAcknowledged: true });
    box.deliver("INBOX", {
      rfcMessageId: "<fr-1@universite.example>",
      from: "claire.dubois@universite.example",
      fromName: "Claire Dubois",
      subject: "Attestation de scolarité",
      text: "Bonjour, merci de m'envoyer votre attestation de scolarité avant vendredi 24 octobre. Cordialement, Claire Dubois",
      sentAt: new Date("2026-10-20T09:12:00+02:00"),
    });
    h.clock.now = new Date("2026-10-21T08:00:00+02:00");
    h.fixtures.set(
      "Attestation de scolarité",
      out({
        language: "fr",
        summary_de: "Claire bittet dich, bis Freitag, 24. Oktober, deine Studienbescheinigung zu schicken.",
        actions: [
          act({
            action_title_de: "Studienbescheinigung schicken",
            next_step_de: "Studienbescheinigung herunterladen und an Claire senden",
            priority: "critical",
            priority_reason_de: "Frist in drei Tagen.",
            deadline: "2026-10-24",
            deadline_precision: "date",
            deadline_kind: "explicit",
            deadline_source_quote: "avant vendredi 24 octobre",
            evidence_quotes: ["merci de m'envoyer votre attestation de scolarité"],
            why_de: "Du bist direkt adressiert und wirst um die Bescheinigung gebeten.",
          }),
        ],
      }),
    );
    const { run, failed } = await runScan(h, user.id, account.id);
    expect(failed).toEqual([]);
    expect(run.status).toBe("succeeded");
    expect(run.stats).toMatchObject({ fetched: 1, newMessages: 1, analyzed: 1, tasksCreated: 1 });

    const [task] = await tasksOf(user.id);
    expect(task).toMatchObject({ origin: "ai", status: "todo", aiTitle: "Studienbescheinigung schicken", aiPriority: "critical", aiDeadlineDate: "2026-10-24", aiDeadlineKind: "explicit" });
    const sources = await h.handle.db.select().from(taskSources).where(eq(taskSources.taskId, task!.id));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ role: "origin", addedBy: "ai" });

    expect(box.markerCalls).toHaveLength(1);
    expect(box.markerCalls[0]!.request).toMatchObject({ strategy: "imap_keyword", keyword: "MailPilot" });
    const [op] = await h.handle.db.select().from(markerOperations).where(eq(markerOperations.accountId, account.id));
    expect(op!.status).toBe("applied");
    const [msg] = await h.handle.db.select().from(messages).where(eq(messages.accountId, account.id));
    expect(msg).toMatchObject({ markerStatus: "applied", analysisStatus: "analyzed", language: "fr" });

    // A second scan of unchanged mail neither analyzes again nor duplicates anything.
    const calls = h.analyzer.calls.length;
    const again = await runScan(h, user.id, account.id);
    expect(again.run.stats).toMatchObject({ fetched: 0, analyzed: 0 });
    expect(h.analyzer.calls.length).toBe(calls);
    expect(await tasksOf(user.id)).toHaveLength(1);
    const [acc] = await h.handle.db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(acc!.lastSuccessfulFetchAt).not.toBeNull();
    expect(acc!.lastSuccessfulAnalysisAt).not.toBeNull();
  });

  it("a reply with a moved deadline updates the same task and keeps manual values", async () => {
    const { user, box, account } = await setup();
    box.deliver("INBOX", { rfcMessageId: "<a1@x>", from: "chef@firma.example", subject: "Bericht", text: "Bitte schick mir den Bericht bis Freitag, 24.10.", sentAt: new Date("2026-10-20T10:00:00Z") });
    h.fixtures.set(
      "Bericht",
      out({ actions: [act({ action_title_de: "Bericht schicken", deadline: "2026-10-24", deadline_precision: "date", deadline_kind: "explicit", deadline_source_quote: "bis Freitag, 24.10." })] }),
    );
    await runScan(h, user.id, account.id);
    const [task] = await tasksOf(user.id);
    // The user set a manual priority in the meantime.
    await h.handle.db.update(tasks).set({ manualPriority: "can_wait" }).where(eq(tasks.id, task!.id));

    box.deliver("INBOX", {
      rfcMessageId: "<a2@x>",
      inReplyTo: "<a1@x>",
      from: "chef@firma.example",
      subject: "Re: Bericht",
      text: "Kleine Änderung: Montag, 27.10., reicht auch.",
      sentAt: new Date("2026-10-21T10:00:00Z"),
    });
    h.fixtures.set(
      "Re: Bericht",
      out({
        actions: [
          act({
            action_title_de: "Bericht schicken",
            deadline: "2026-10-27",
            deadline_precision: "date",
            deadline_kind: "explicit",
            deadline_source_quote: "Montag, 27.10., reicht auch",
            suggested_existing_task_id: task!.id,
            update_summary_de: "Die Frist wurde von Freitag auf Montag verschoben.",
          }),
        ],
      }),
    );
    // The earlier task was offered as candidate from the same thread.
    await runScan(h, user.id, account.id);
    const input = h.analyzer.calls.at(-1)!;
    expect(input.candidateTasks.map((c) => c.id)).toContain(task!.id);
    expect(input.candidateTasks.find((c) => c.id === task!.id)?.sameThread).toBe(true);
    expect(input.thread).toHaveLength(1);

    const all = await tasksOf(user.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ aiDeadlineDate: "2026-10-27", manualPriority: "can_wait", latestChange: "Die Frist wurde von Freitag auf Montag verschoben." });
    const events = await h.handle.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task!.id), eq(taskEvents.kind, "deadline_changed")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "ai", oldValue: "2026-10-24", newValue: "2026-10-27" });
    expect(events[0]!.messageId).not.toBeNull();
    expect(await h.handle.db.select().from(taskSources).where(eq(taskSources.taskId, task!.id))).toHaveLength(2);
  });

  it("an unclear circular asks first and creates nothing until answered", async () => {
    const { user, box, account } = await setup();
    box.deliver("INBOX", {
      rfcMessageId: "<round@x>",
      from: "sekretariat@schule.example",
      subject: "Info an alle B2",
      text: "Liebe Klasse B2, bitte bringt bis Donnerstag die unterschriebene Einverständniserklärung mit.",
      sentAt: new Date("2026-10-20T07:00:00Z"),
    });
    h.fixtures.set(
      "Info an alle B2",
      out({
        relevance: "uncertain",
        actions: [act({ action_title_de: "Einverständniserklärung abgeben" })],
        clarifications: [clar({ kind: "membership", question_de: "Diese Mail betrifft die Gruppe B2. Gehörst du dazu?", subject: "B2", related_action_index: 0 })],
      }),
    );
    await runScan(h, user.id, account.id);
    expect(await tasksOf(user.id)).toHaveLength(0);
    const [c] = await h.handle.db.select().from(clarificationRequests).where(eq(clarificationRequests.userId, user.id));
    expect(c).toMatchObject({ kind: "membership", subject: "B2", status: "open", actionIndex: 0 });
    expect(c!.options.map((o) => o.label)).toEqual(["Ja", "Nein", "Diesmal nicht", "Weiß ich noch nicht"]);

    // Answer "Ja" (as the API stores it) and let the worker apply it.
    await h.handle.db.update(clarificationRequests).set({ status: "answered", answerOptionId: "yes", answerScope: "once", answeredAt: new Date() }).where(eq(clarificationRequests.id, c!.id));
    await h.deps.enqueue("apply_clarification", { clarificationId: c!.id });
    await h.drain();
    const created = await tasksOf(user.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.aiTitle).toBe("Einverständniserklärung abgeben");
  });

  it("a confirmed permanent assignment is used for later mails without asking", async () => {
    const { user, box, account } = await setup();
    await h.handle.db.insert(schema.userRules).values({ userId: user.id, kind: "membership", subject: "B2", applies: true });
    box.deliver("INBOX", { rfcMessageId: "<round2@x>", from: "sekretariat@schule.example", subject: "Ausflug B2", text: "Liebe B2, bitte meldet euch bis Montag für den Ausflug an.", sentAt: new Date("2026-10-20T07:00:00Z") });
    h.fixtures.set(
      "Ausflug B2",
      out({
        relevance: "uncertain",
        actions: [act({ action_title_de: "Für den Ausflug anmelden" })],
        clarifications: [clar({ kind: "membership", question_de: "Gehörst du zu B2?", subject: "b2", related_action_index: 0 })],
      }),
    );
    await runScan(h, user.id, account.id);
    expect(h.analyzer.calls.at(-1)!.facts).toEqual([{ kind: "membership", subject: "B2", applies: true }]);
    expect(await h.handle.db.select().from(clarificationRequests).where(eq(clarificationRequests.userId, user.id))).toHaveLength(0);
    expect((await tasksOf(user.id)).map((t) => t.aiTitle)).toEqual(["Für den Ausflug anmelden"]);
  });

  it("sends only the reply itself to the AI, with the quoted mail as short context", async () => {
    const { user, box, account } = await setup();
    box.deliver("INBOX", {
      rfcMessageId: "<q1@x>",
      from: "kollegin@firma.example",
      subject: "Re: Protokoll",
      text: [
        "Passt, bitte schick mir das Protokoll bis Mittwoch.",
        "",
        "Viele Grüße",
        "Anna",
        "",
        "Am 20.10.2026 um 10:00 schrieb Ich <ich@firma.example>:",
        "> Hallo Anna,",
        "> ich habe das Protokoll fast fertig.",
        "> Gruß",
      ].join("\n"),
      sentAt: new Date("2026-10-21T08:00:00Z"),
    });
    h.fixtures.set("Re: Protokoll", out({ actions: [act({ action_title_de: "Protokoll schicken" })] }));
    await runScan(h, user.id, account.id);
    const input = h.analyzer.calls.at(-1)!;
    expect(input.message.text).toContain("bitte schick mir das Protokoll bis Mittwoch");
    expect(input.message.text).not.toContain("ich habe das Protokoll fast fertig");
    expect(input.message.quotedContext).toContain("ich habe das Protokoll fast fertig");
  });

  it("a mail with an attachment is marked when the task needs the attachment", async () => {
    const { user, box, account } = await setup();
    box.deliver("INBOX", {
      rfcMessageId: "<att@x>",
      from: "amt@stadt.example",
      subject: "Antrag",
      text: "Bitte füllen Sie das angehängte Formular aus und senden Sie es zurück.",
      sentAt: new Date("2026-10-20T07:00:00Z"),
      attachments: [{ filename: "Formular.pdf", contentType: "application/pdf", size: 48213 }],
    });
    h.fixtures.set(
      "Antrag",
      out({
        actions: [
          act({
            action_title_de: "Formular ausfüllen und zurücksenden",
            requires_attachment_reading: true,
            checklist_de: ["Formular ausfüllen", "Formular zurücksenden"],
          }),
        ],
      }),
    );
    await runScan(h, user.id, account.id);
    expect(h.analyzer.calls.at(-1)!.message.attachments).toEqual([{ filename: "Formular.pdf", contentType: "application/pdf", size: 48213 }]);
    const [task] = await tasksOf(user.id);
    expect(task!.requiresAttachmentReading).toBe(true);
    const items = await h.handle.db.select().from(taskChecklistItems).where(eq(taskChecklistItems.taskId, task!.id));
    expect(items.map((i) => i.title)).toEqual(["Formular ausfüllen", "Formular zurücksenden"]);
  });

  it("a moved original mail keeps its task, source and analysis", async () => {
    const { user, box, account } = await setup();
    await h.handle.db.update(schema.mailFolders).set({ selected: true }).where(and(eq(schema.mailFolders.accountId, account.id), eq(schema.mailFolders.path, "Archiv")));
    box.deliver("INBOX", { rfcMessageId: "<move@x>", from: "a@b.example", subject: "Rechnung", text: "Bitte bezahle die Rechnung bis 31.10.", sentAt: new Date("2026-10-20T07:00:00Z") });
    h.fixtures.set("Rechnung", out({ actions: [act({ action_title_de: "Rechnung bezahlen" })] }));
    await runScan(h, user.id, account.id);
    const calls = h.analyzer.calls.length;
    box.move("<move@x>", "INBOX", "Archiv");
    await runScan(h, user.id, account.id);
    expect(h.analyzer.calls.length).toBe(calls);
    const msgs = await h.handle.db.select().from(messages).where(eq(messages.accountId, account.id));
    expect(msgs).toHaveLength(1);
    const locations = await h.handle.db.select({ present: schema.messageLocations.present, path: schema.mailFolders.path }).from(schema.messageLocations).innerJoin(schema.mailFolders, eq(schema.mailFolders.id, schema.messageLocations.folderId)).where(eq(schema.messageLocations.messageId, msgs[0]!.id));
    expect(locations.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { present: true, path: "Archiv" },
      { present: false, path: "INBOX" },
    ]);
    const all = await tasksOf(user.id);
    expect(all).toHaveLength(1);
    expect(await h.handle.db.select().from(taskSources).where(eq(taskSources.taskId, all[0]!.id))).toHaveLength(1);
  });

  it("a failed fetch is shown with a concrete action and creates nothing", async () => {
    const { user, box, account } = await setup();
    box.failNext = new ConnectorError("auth_failed", "Anmeldung beim Mailserver abgelehnt", "Konto erneut verbinden");
    const { run } = await runScan(h, user.id, account.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Konto erneut verbinden");
    const [acc] = await h.handle.db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(acc).toMatchObject({ status: "needs_reauth", lastErrorCode: "auth_failed", lastErrorAction: "Konto erneut verbinden" });
    expect(await tasksOf(user.id)).toHaveLength(0);
  });

  it("informational mail and own sent mail never become tasks", async () => {
    const { user, box, account } = await setup();
    box.deliver("INBOX", { rfcMessageId: "<nl@x>", from: "news@shop.example", subject: "Newsletter Oktober", text: "Unsere Angebote am 30.10.!", sentAt: new Date("2026-10-20T07:00:00Z") });
    h.fixtures.set("Newsletter Oktober", out({ relevance: "informational", actions: [act({ action_title_de: "Angebote ansehen" })] }));
    box.deliver("Sent", { rfcMessageId: "<sent@x>", from: account.emailAddress, subject: "Meine Antwort", text: "Danke!", sentAt: new Date("2026-10-20T08:00:00Z") });
    await runScan(h, user.id, account.id);
    expect(await tasksOf(user.id)).toHaveLength(0);
    const msgs = await h.handle.db.select().from(messages).where(eq(messages.accountId, account.id));
    expect(msgs.find((m) => m.subject === "Meine Antwort")).toMatchObject({ isFromMe: true, analysisStatus: "skipped" });
    expect(msgs.find((m) => m.subject === "Newsletter Oktober")).toMatchObject({ analysisStatus: "analyzed" });
    expect(h.analyzer.calls.some((c) => c.message.subject === "Meine Antwort")).toBe(false);
  });

  it("a dismissed task is not created again; a done task gets a follow-up instead of reopening", async () => {
    const { user, box, account } = await setup();
    box.deliver("INBOX", { rfcMessageId: "<d1@x>", from: "verein@x.example", subject: "Beitrag", text: "Bitte überweise den Jahresbeitrag.", sentAt: new Date("2026-10-20T07:00:00Z") });
    h.fixtures.set("Beitrag", out({ actions: [act({ action_title_de: "Jahresbeitrag überweisen" })] }));
    await runScan(h, user.id, account.id);
    const [task] = await tasksOf(user.id);
    await h.handle.db.update(tasks).set({ status: "done", doneAt: new Date() }).where(eq(tasks.id, task!.id));

    // Content of the same mail changed (e.g. provider re-delivered it): no reopening.
    box.deliver("INBOX", {
      rfcMessageId: "<d2@x>",
      inReplyTo: "<d1@x>",
      from: "verein@x.example",
      subject: "Re: Beitrag",
      text: "Danke! Bitte schick uns noch die neue Adresse.",
      sentAt: new Date("2026-10-22T07:00:00Z"),
    });
    h.fixtures.set("Re: Beitrag", out({ actions: [act({ action_title_de: "Neue Adresse schicken", suggested_existing_task_id: task!.id })] }));
    await runScan(h, user.id, account.id);
    const all = await tasksOf(user.id);
    expect(all).toHaveLength(2);
    expect(all.find((t) => t.id === task!.id)!.status).toBe("done");
    expect(all.find((t) => t.id !== task!.id)!.aiTitle).toBe("Neue Adresse schicken");

    // A dismissed task stays dismissed when its own mail is analyzed again.
    const follow = all.find((t) => t.id !== task!.id)!;
    await h.handle.db.update(tasks).set({ status: "dismissed", dismissedAt: new Date(), statusBeforeDismiss: "todo" }).where(eq(tasks.id, follow.id));
    const [m2] = await h.handle.db.select().from(messages).where(eq(messages.rfcMessageId, "<d2@x>"));
    await h.deps.enqueue("analyze_message", { messageId: m2!.id, runId: null, force: true });
    await h.drain();
    const after = await tasksOf(user.id);
    expect(after).toHaveLength(2);
    expect(after.find((t) => t.id === follow.id)!.status).toBe("dismissed");
  });

  it("pauses analysis at the budget, keeps collecting mail and resumes when budget is raised", async () => {
    const { user, box, account } = await setup();
    await h.handle.db.update(schema.users).set({ aiMonthlyBudgetCents: 0 }).where(eq(schema.users.id, user.id));
    box.deliver("INBOX", { rfcMessageId: "<b1@x>", from: "a@b.example", subject: "Budget", text: "Bitte antworte bis morgen.", sentAt: new Date() });
    h.fixtures.set("Budget", out({ actions: [act({ action_title_de: "Antworten" })] }));
    h.clock.now = new Date();
    const { run } = await runScan(h, user.id, account.id);
    expect(run.stats).toMatchObject({ fetched: 1, budgetPaused: 1, analyzed: 0 });
    const [msg] = await h.handle.db.select().from(messages).where(eq(messages.accountId, account.id));
    expect(msg).toMatchObject({ analysisStatus: "budget_paused" });
    expect(await tasksOf(user.id)).toHaveLength(0);

    await h.handle.db.update(schema.users).set({ aiMonthlyBudgetCents: 500, scanEnabled: false }).where(eq(schema.users.id, user.id));
    await h.deps.enqueue("scheduled_scans", {});
    await h.drain();
    expect(await tasksOf(user.id)).toHaveLength(1);
  });

  it("limited retries: a failing analysis ends as failed, counted, never as 'no task'", async () => {
    const { user, box, account } = await setup();
    box.deliver("INBOX", { rfcMessageId: "<f1@x>", from: "a@b.example", subject: "Ohne Fixture", text: "Irgendwas.", sentAt: new Date() });
    h.clock.now = new Date();
    await runScan(h, user.id, account.id);
    const [msg] = await h.handle.db.select().from(messages).where(eq(messages.accountId, account.id));
    expect(msg).toMatchObject({ analysisStatus: "failed" });
    expect(msg!.analysisError).toContain("Keine Fixture");
    const analyses = await h.handle.db.select().from(messageAnalyses).where(eq(messageAnalyses.messageId, msg!.id));
    expect(analyses.every((a) => a.status === "failed")).toBe(true);
  });
});

describe("worker without AI", () => {
  it("keeps mail visibly unanalyzed instead of reporting 'no tasks'", async () => {
    const h = await createHarness({ analyzer: "off" });
    try {
      const user = await h.createUser();
      const box = new FakeMailbox(imapCaps());
      const account = await h.createAccount(user.id, box);
      await selectDefaultFolders(h, account);
      box.deliver("INBOX", { rfcMessageId: "<off@x>", from: "a@b.example", subject: "Ohne KI", text: "Bitte melden.", sentAt: new Date() });
      await runScan(h, user.id, account.id);
      const [msg] = await h.handle.db.select().from(messages).where(eq(messages.accountId, account.id));
      expect(msg).toMatchObject({ analysisStatus: "pending" });
      expect(msg!.analysisError).toContain("nicht eingerichtet");
    } finally {
      await h.close();
    }
  });
});

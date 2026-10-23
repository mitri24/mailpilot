import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../api/src/app.js";
import { loadConfig } from "../../api/src/config.js";
import type { JobQueue } from "../../api/src/queue.js";
import type { AccountServices } from "../../api/src/routes/accounts.js";
import { FakeMailbox } from "./fake-mailbox.js";
import { testDatabaseUrl } from "./global-setup.js";
import { createHarness, imapCaps, type Harness } from "./harness.js";
import { act, clar, out } from "./wire.js";

/**
 * Spec section 16 end to end: API and worker on one database, a scriptable mailbox instead of a
 * real provider and fixture model outputs instead of a real model.
 */
describe("scenario: from a French mail to a finished task", () => {
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const pendingBoxes: FakeMailbox[] = [];

  beforeAll(async () => {
    h = await createHarness();
    const queue: JobQueue = { add: (name, payload, options) => h.deps.enqueue(name, payload as object, options ?? {}), close: async () => {} };
    const services: AccountServices = {
      probeImap: async () => {
        const box = pendingBoxes[pendingBoxes.length - 1]!;
        const folders = await box.connector().listFolders();
        return { capabilities: box.capabilities, folders };
      },
      probeAccount: async () => ({ capabilities: imapCaps(), folders: [] }),
      suggest: async () => ({ provider: "imap", imap: null, confidence: "unknown", notes: [] }),
      oauth: {},
    };
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseUrl(),
      CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      DEV_LOGIN_ENABLED: "true",
    });
    app = await buildApp({ config, db: h.handle.db, queue, accounts: services });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await h.close();
  });

  async function connect(headers: Record<string, string>, email: string) {
    const box = new FakeMailbox(imapCaps());
    pendingBoxes.push(box);
    const res = await app.inject({
      method: "POST",
      url: "/v1/accounts/imap",
      headers,
      payload: { displayName: email, emailAddress: email, host: "imap.example.test", username: email, password: "app-passwort" },
    });
    expect(res.statusCode).toBe(200);
    const account = res.json();
    h.mailboxes.set(account.id, box);
    return { account, box };
  }

  it("runs the whole daily flow across two accounts and two devices", async () => {
    h.clock.now = new Date("2026-10-21T08:00:00+02:00");
    const login = (await app.inject({ method: "POST", url: "/v1/auth/dev", payload: { email: `szenario-${randomUUID()}@example.test` } })).json();
    const auth = { authorization: `Bearer ${login.token}` };

    // Two different accounts: university (with marker) and private.
    const uni = await connect(auth, `ich-${randomUUID().slice(0, 6)}@universite.example`);
    const priv = await connect(auth, `ich-${randomUUID().slice(0, 6)}@privat.example`);
    const marker = await app.inject({
      method: "PATCH",
      url: `/v1/accounts/${uni.account.id}`,
      headers: auth,
      payload: { marker: { strategy: "imap_keyword", keyword: "MailPilot", folder: null, acknowledgedLimitations: true } },
    });
    expect(marker.statusCode).toBe(200);
    expect(marker.json().markerReliable).toBe(false);

    uni.box.deliver("INBOX", {
      rfcMessageId: "<s-fr@universite.example>",
      from: "claire.dubois@universite.example",
      fromName: "Claire Dubois",
      subject: "Attestation de scolarité",
      text: "Bonjour, merci de m'envoyer votre attestation de scolarité avant vendredi 24 octobre. Cordialement, Claire Dubois",
      sentAt: new Date("2026-10-20T09:12:00+02:00"),
    });
    priv.box.deliver("INBOX", {
      rfcMessageId: "<s-de@privat.example>",
      from: "vermieter@privat.example",
      subject: "Nebenkostenabrechnung",
      text: "Hallo, bitte prüfe die Nebenkostenabrechnung bis 15.11. und melde dich bei Fragen.",
      sentAt: new Date("2026-10-20T11:00:00+02:00"),
    });
    priv.box.deliver("INBOX", {
      rfcMessageId: "<s-round@privat.example>",
      from: "info@verein.example",
      subject: "Rundmail Gruppe B2",
      text: "An alle der Gruppe B2: Bitte tragt euch bis Sonntag in die Liste ein.",
      sentAt: new Date("2026-10-20T12:00:00+02:00"),
    });
    h.fixtures.set(
      "Attestation de scolarité",
      out({
        language: "fr",
        summary_de: "Claire bittet dich, bis Freitag, 24. Oktober, deine Studienbescheinigung zu schicken.",
        actions: [
          act({
            action_title_de: "Studienbescheinigung schicken",
            priority: "critical",
            priority_reason_de: "Frist am Freitag.",
            deadline: "2026-10-24",
            deadline_precision: "date",
            deadline_kind: "explicit",
            deadline_source_quote: "avant vendredi 24 octobre",
            evidence_quotes: ["merci de m'envoyer votre attestation de scolarité"],
          }),
        ],
      }),
    );
    h.fixtures.set(
      "Nebenkostenabrechnung",
      out({ actions: [act({ action_title_de: "Nebenkostenabrechnung prüfen", deadline: "2026-11-15", deadline_precision: "date", deadline_kind: "explicit", deadline_source_quote: "bis 15.11." })] }),
    );
    h.fixtures.set(
      "Rundmail Gruppe B2",
      out({
        relevance: "uncertain",
        actions: [act({ action_title_de: "In die Liste eintragen" })],
        clarifications: [clar({ kind: "membership", question_de: "Diese Mail betrifft die Gruppe B2. Gehörst du dazu?", subject: "B2", related_action_index: 0 })],
      }),
    );

    // Manual scan for all active accounts; the worker processes the queue.
    const scans = await app.inject({ method: "POST", url: "/v1/scans", headers: auth, payload: {} });
    expect(scans.json().runs).toHaveLength(2);
    const { failed } = await h.drain();
    expect(failed).toEqual([]);

    // Heute: the evidenced urgent deadline first; the clarification is counted, not turned into a task.
    const today = (await app.inject({ method: "GET", url: "/v1/today", headers: auth })).json();
    expect(today.next.map((t: { title: string }) => t.title)).toEqual(["Studienbescheinigung schicken", "Nebenkostenabrechnung prüfen"]);
    expect(today.openClarifications).toBe(1);
    const task = today.next[0];
    expect(task).toMatchObject({ status: "todo", priority: "critical", priorityReason: "Frist am Freitag.", deadline: { date: "2026-10-24", kind: "explicit" } });
    expect(task.primarySource.subject).toBe("Attestation de scolarité");
    expect(uni.box.markerCalls).toHaveLength(1);

    // Detail: German summary, original passages, source mail and history.
    const detail = (await app.inject({ method: "GET", url: `/v1/tasks/${task.id}`, headers: auth })).json();
    expect(detail.task.summary).toContain("Studienbescheinigung");
    expect(detail.sources[0].evidenceQuotes).toEqual(["merci de m'envoyer votre attestation de scolarité"]);
    expect(detail.events.map((e: { kind: string }) => e.kind)).toContain("created_auto");
    const mail = (await app.inject({ method: "GET", url: `/v1/messages/${detail.sources[0].messageId}`, headers: auth })).json();
    expect(mail.bodyText).toContain("attestation de scolarité");

    // Answer the clarification: yes, permanently. The held task appears, a rule is visible.
    const [question] = (await app.inject({ method: "GET", url: "/v1/clarifications", headers: auth })).json().clarifications;
    const answered = await app.inject({ method: "POST", url: `/v1/clarifications/${question.id}/answer`, headers: auth, payload: { optionId: "yes", scope: "permanent" } });
    expect(answered.json().result.status).toBe("applied");
    await h.drain();
    const rules = (await app.inject({ method: "GET", url: "/v1/rules", headers: auth })).json().rules;
    expect(rules).toHaveLength(1);
    const titles = (await app.inject({ method: "GET", url: "/v1/tasks", headers: auth })).json().tasks.map((t: { title: string }) => t.title);
    expect(titles).toContain("In die Liste eintragen");

    // Device A (phone) is offline: it moves the task to Doing and writes a note into its outbox.
    const snapshot = (await app.inject({ method: "GET", url: "/v1/sync/changes", headers: auth })).json();
    const base = task.version;
    const outbox = [
      { idempotencyKey: randomUUID(), type: "task.update", entityId: task.id, baseVersion: base, payload: { status: "doing" } },
      { idempotencyKey: randomUUID(), type: "note.create", entityId: randomUUID(), payload: { taskId: task.id, body: "Bescheinigung im Portal angefordert" } },
    ];
    // Device B (Mac) is online and finishes the task first.
    const done = await app.inject({ method: "PATCH", url: `/v1/tasks/${task.id}`, headers: auth, payload: { baseVersion: base, patch: { status: "done" } } });
    expect(done.json().result.status).toBe("applied");
    // Device A comes back online: its stale status change must not reopen the finished task; the note is kept.
    const replay = (await app.inject({ method: "POST", url: "/v1/sync/mutations", headers: auth, payload: { mutations: outbox } })).json();
    expect(replay.results.map((r: { status: string }) => r.status)).toEqual(["conflict", "applied"]);
    expect(replay.results[0].conflictingFields).toEqual(["status"]);
    const after = (await app.inject({ method: "GET", url: `/v1/tasks/${task.id}`, headers: auth })).json();
    expect(after.task.status).toBe("done");
    expect(after.notes.map((n: { body: string }) => n.body)).toEqual(["Bescheinigung im Portal angefordert"]);

    // Both devices converge through the change feed.
    const delta = (await app.inject({ method: "GET", url: `/v1/sync/changes?cursor=${snapshot.nextCursor}`, headers: auth })).json();
    expect(delta.changes.find((c: { entityType: string; entityId: string }) => c.entityType === "task" && c.entityId === task.id).data.status).toBe("done");
    expect(delta.changes.some((c: { entityType: string }) => c.entityType === "note")).toBe(true);

    // Done: gone from Heute, still findable; the original mail was neither deleted nor moved.
    const todayAfter = (await app.inject({ method: "GET", url: "/v1/today", headers: auth })).json();
    expect([...todayAfter.next, ...todayAfter.moreUrgent].map((t: { id: string }) => t.id)).not.toContain(task.id);
    const doneList = (await app.inject({ method: "GET", url: "/v1/tasks?status=done", headers: auth })).json().tasks;
    expect(doneList.map((t: { id: string }) => t.id)).toContain(task.id);
    expect(uni.box.folders.get("INBOX")!.messages.map((m) => m.mail.rfcMessageId)).toContain("<s-fr@universite.example>");

    // Usage reflects the analyses that actually ran.
    const usage = (await app.inject({ method: "GET", url: "/v1/usage", headers: auth })).json();
    expect(usage.analyzedThisMonth).toBe(3);
    expect(usage.pendingAnalysisCount).toBe(0);
  });
});

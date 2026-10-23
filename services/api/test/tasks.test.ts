import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@mailpilot/database";
import { createTestContext, login, seedAccount, seedMessage, uuid, type Session, type TestContext } from "./helpers.js";

describe("tasks", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());

  const createTask = async (s: Session, payload: Record<string, unknown>, key: string = uuid()) =>
    ctx.app.inject({ method: "POST", url: "/v1/tasks", headers: { ...s.headers, "idempotency-key": key }, payload });

  const patch = async (s: Session, id: string, baseVersion: number, p: Record<string, unknown>) =>
    ctx.app.inject({ method: "PATCH", url: `/v1/tasks/${id}`, headers: { ...s.headers, "idempotency-key": uuid() }, payload: { baseVersion, patch: p } });

  it("creating with the same idempotency key twice yields one task", async () => {
    const s = await login(ctx.app);
    const key = uuid();
    const a = await createTask(s, { title: "Rechnung prüfen" }, key);
    const b = await createTask(s, { title: "Rechnung prüfen" }, key);
    expect(a.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    const list = await ctx.app.inject({ method: "GET", url: "/v1/tasks", headers: s.headers });
    expect(list.json().tasks).toHaveLength(1);

    const reused = await createTask(s, { title: "Etwas anderes" }, key);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe("idempotency_key_reused");

    const invalid = await createTask(s, { title: "x" }, "not-a-uuid");
    expect(invalid.statusCode).toBe(400);
  });

  it("merges concurrent edits field by field and reports real conflicts", async () => {
    const s = await login(ctx.app);
    const task = (await createTask(s, { title: "Angebot schreiben" })).json();
    expect(task.version).toBe(1);

    const first = await patch(s, task.id, 1, { title: "Angebot an Kunde schreiben" });
    expect(first.json().result).toMatchObject({ status: "applied", version: 2 });

    // A second device still at version 1 changes a different field: no conflict.
    const other = await patch(s, task.id, 1, { priority: "critical" });
    expect(other.json().result).toMatchObject({ status: "applied", version: 3, conflictingFields: [] });

    // The same stale device edits the title, which changed after its base version.
    const stale = await patch(s, task.id, 1, { title: "Alter Titel", nextStep: "Zahlen sammeln" });
    const body = stale.json();
    expect(body.result.status).toBe("conflict");
    expect(body.result.conflictingFields).toEqual(["title"]);
    expect(body.task.title).toBe("Angebot an Kunde schreiben");
    expect(body.task.nextStep).toBe("Zahlen sammeln");
    expect(body.task.priority).toBe("critical");
  });

  it("manual values win over AI values and can be reset", async () => {
    const s = await login(ctx.app);
    const task = (await createTask(s, { title: "Vertrag" })).json();
    await ctx.handle.db
      .update(schema.tasks)
      .set({ aiTitle: "Vertrag unterschreiben", aiPriority: "can_wait", aiDeadlineDate: "2030-01-10", aiDeadlinePrecision: "date", aiDeadlineKind: "explicit" })
      .where(eq(schema.tasks.id, task.id));

    let res = await patch(s, task.id, 1, { priority: "critical", deadline: { date: "2030-01-05", dateTime: null, precision: "date" } });
    let t = res.json().task;
    expect(t.priority).toBe("critical");
    expect(t.priorityIsManual).toBe(true);
    expect(t.ai.priority).toBe("can_wait");
    expect(t.deadline).toMatchObject({ date: "2030-01-05", kind: "explicit" });
    expect(t.ai.deadline.date).toBe("2030-01-10");

    res = await patch(s, task.id, t.version, { priority: null, title: null, deadline: null });
    t = res.json().task;
    expect(t.priority).toBe("can_wait");
    expect(t.priorityIsManual).toBe(false);
    expect(t.title).toBe("Vertrag unterschreiben");
    expect(t.deadline.date).toBe("2030-01-10");

    res = await patch(s, task.id, t.version, { deadlineCleared: true });
    t = res.json().task;
    expect(t.deadline).toBeNull();
    expect(t.deadlineIsManual).toBe(true);
  });

  it("dismiss and restore keep the previous status", async () => {
    const s = await login(ctx.app);
    const task = (await createTask(s, { title: "Termin" })).json();
    const doing = (await patch(s, task.id, 1, { status: "doing" })).json().task;
    const dismissed = await ctx.app.inject({ method: "POST", url: `/v1/tasks/${task.id}/dismiss`, headers: s.headers, payload: { baseVersion: doing.version } });
    expect(dismissed.json().task.status).toBe("dismissed");
    const restored = await ctx.app.inject({
      method: "POST",
      url: `/v1/tasks/${task.id}/restore`,
      headers: s.headers,
      payload: { baseVersion: dismissed.json().task.version },
    });
    expect(restored.json().task.status).toBe("doing");
    const list = await ctx.app.inject({ method: "GET", url: "/v1/tasks?status=dismissed", headers: s.headers });
    expect(list.json().tasks).toHaveLength(0);
  });

  it("keeps both versions when a note was edited concurrently", async () => {
    const s = await login(ctx.app);
    const task = (await createTask(s, { title: "Notizen", note: "Erste Fassung" })).json();
    const detail = (await ctx.app.inject({ method: "GET", url: `/v1/tasks/${task.id}`, headers: s.headers })).json();
    const note = detail.notes[0];
    expect(note.body).toBe("Erste Fassung");

    const ok = await ctx.app.inject({ method: "PATCH", url: `/v1/notes/${note.id}`, headers: s.headers, payload: { baseVersion: 1, body: "Gerät A" } });
    expect(ok.json().result).toMatchObject({ status: "applied", version: 2 });
    const stale = await ctx.app.inject({ method: "PATCH", url: `/v1/notes/${note.id}`, headers: s.headers, payload: { baseVersion: 1, body: "Gerät B" } });
    const r = stale.json().result;
    expect(r.status).toBe("conflict");
    expect(r.createdEntityId).toBeTruthy();

    const after = (await ctx.app.inject({ method: "GET", url: `/v1/tasks/${task.id}`, headers: s.headers })).json();
    const bodies = after.notes.map((n: { body: string }) => n.body).sort();
    expect(bodies).toEqual(["Gerät A", "Gerät B"]);
    const copy = after.notes.find((n: { id: string }) => n.id === r.createdEntityId);
    expect(copy.conflictOfNoteId).toBe(note.id);
    expect(after.events.some((e: { kind: string }) => e.kind === "note_conflict")).toBe(true);
  });

  it("checklist: ticking merges, stale title edits conflict", async () => {
    const s = await login(ctx.app);
    const task = (await createTask(s, { title: "Umzug" })).json();
    const item = (await ctx.app.inject({ method: "POST", url: `/v1/tasks/${task.id}/checklist`, headers: s.headers, payload: { title: "Kartons" } })).json().item;
    await ctx.app.inject({ method: "PATCH", url: `/v1/checklist/${item.id}`, headers: s.headers, payload: { baseVersion: 1, title: "Kartons kaufen" } });
    const tick = await ctx.app.inject({ method: "PATCH", url: `/v1/checklist/${item.id}`, headers: s.headers, payload: { baseVersion: 1, done: true } });
    expect(tick.json().result.status).toBe("applied");
    const rename = await ctx.app.inject({ method: "PATCH", url: `/v1/checklist/${item.id}`, headers: s.headers, payload: { baseVersion: 1, title: "Alt" } });
    expect(rename.json().result.status).toBe("conflict");
    const detail = (await ctx.app.inject({ method: "GET", url: `/v1/tasks/${task.id}`, headers: s.headers })).json();
    expect(detail.checklist[0]).toMatchObject({ title: "Kartons kaufen", done: true });
  });

  it("merge keeps notes and sources and can be undone", async () => {
    const s = await login(ctx.app);
    const account = await seedAccount(ctx.handle, s.userId);
    const m1 = await seedMessage(ctx.handle, account.id, { subject: "Elternabend 1" });
    const m2 = await seedMessage(ctx.handle, account.id, { subject: "Elternabend 2" });
    const a = (await createTask(s, { title: "Elternabend", sourceMessageIds: [m1.id], note: "Notiz A" })).json();
    const b = (await createTask(s, { title: "Elternabend vorbereiten", sourceMessageIds: [m2.id] })).json();

    const merged = await ctx.app.inject({ method: "POST", url: `/v1/tasks/${a.id}/merge`, headers: s.headers, payload: { intoTaskId: b.id } });
    expect(merged.statusCode).toBe(200);
    const { mergeId } = merged.json();
    const target = (await ctx.app.inject({ method: "GET", url: `/v1/tasks/${b.id}`, headers: s.headers })).json();
    expect(target.sources.map((x: { messageId: string }) => x.messageId).sort()).toEqual([m1.id, m2.id].sort());
    expect(target.notes.map((n: { body: string }) => n.body)).toEqual(["Notiz A"]);
    const open = (await ctx.app.inject({ method: "GET", url: "/v1/tasks", headers: s.headers })).json().tasks;
    expect(open.map((t: { id: string }) => t.id)).toEqual([b.id]);

    const undo = await ctx.app.inject({ method: "POST", url: `/v1/merges/${mergeId}/undo`, headers: s.headers });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().mergedIntoTaskId).toBeNull();
    const source = (await ctx.app.inject({ method: "GET", url: `/v1/tasks/${a.id}`, headers: s.headers })).json();
    expect(source.notes.map((n: { body: string }) => n.body)).toEqual(["Notiz A"]);
    expect(source.sources.map((x: { messageId: string }) => x.messageId)).toEqual([m1.id]);
  });

  it("turns an overlooked mail into a task and corrections never touch the mail", async () => {
    const s = await login(ctx.app);
    const account = await seedAccount(ctx.handle, s.userId);
    const msg = await seedMessage(ctx.handle, account.id, { subject: "Formular ausfüllen" });
    const res = await ctx.app.inject({ method: "POST", url: `/v1/messages/${msg.id}/task`, headers: s.headers, payload: {} });
    expect(res.statusCode).toBe(200);
    const task = res.json();
    expect(task.title).toBe("Formular ausfüllen");
    expect(task.origin).toBe("mail_manual");
    expect(task.primarySource.messageId).toBe(msg.id);

    // A second device taking over the same mail gets the same task, not a duplicate.
    const second = await ctx.app.inject({ method: "POST", url: `/v1/messages/${msg.id}/task`, headers: s.headers, payload: { title: "Formular" } });
    expect(second.json().id).toBe(task.id);

    const corr = await ctx.app.inject({ method: "POST", url: `/v1/tasks/${task.id}/corrections`, headers: s.headers, payload: { kind: "not_a_task" } });
    expect(corr.json().task.status).toBe("dismissed");
    const [stored] = await ctx.handle.db.select().from(schema.messages).where(eq(schema.messages.id, msg.id));
    expect(stored!.bodyText).toBe(msg.bodyText);
    expect(stored!.deletedAt).toBeNull();
  });

  it("other users cannot read or change a task", async () => {
    const owner = await login(ctx.app);
    const intruder = await login(ctx.app);
    const task = (await createTask(owner, { title: "Privat" })).json();
    const read = await ctx.app.inject({ method: "GET", url: `/v1/tasks/${task.id}`, headers: intruder.headers });
    expect(read.statusCode).toBe(404);
    const write = await patch(intruder, task.id, 1, { title: "Übernommen" });
    expect(write.json().result.status).toBe("rejected");
    const mine = (await ctx.app.inject({ method: "GET", url: `/v1/tasks/${task.id}`, headers: owner.headers })).json();
    expect(mine.task.title).toBe("Privat");
  });

  it("search finds tasks by title", async () => {
    const s = await login(ctx.app);
    await createTask(s, { title: "Steuererklärung abgeben" });
    await createTask(s, { title: "Blumen gießen" });
    const res = await ctx.app.inject({ method: "GET", url: `/v1/tasks?search=${encodeURIComponent("steuer")}`, headers: s.headers });
    expect(res.json().tasks.map((t: { title: string }) => t.title)).toEqual(["Steuererklärung abgeben"]);
  });
});

describe("message analysis retry", () => {
  it("queues a forced analysis in the user's analysis queue", async () => {
    const ctx = await createTestContext();
    try {
      const s = await login(ctx.app);
      const account = await seedAccount(ctx.handle, s.userId);
      const msg = await seedMessage(ctx.handle, account.id, { analysisStatus: "failed", analysisError: "x" });
      const res = await ctx.app.inject({ method: "POST", url: `/v1/messages/${msg.id}/analyze`, headers: s.headers });
      expect(res.json()).toEqual({ queued: true });
      expect(ctx.queue.jobs.at(-1)).toMatchObject({ name: "analyze_message", payload: { messageId: msg.id, force: true }, options: { queueName: `analyze:${s.userId}` } });
      const other = await login(ctx.app);
      expect((await ctx.app.inject({ method: "POST", url: `/v1/messages/${msg.id}/analyze`, headers: other.headers })).statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});

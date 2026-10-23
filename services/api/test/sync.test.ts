import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, login, uuid, type Session, type TestContext } from "./helpers.js";

describe("sync", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());

  const changes = async (s: Session, cursor?: string) =>
    (await ctx.app.inject({ method: "GET", url: `/v1/sync/changes${cursor ? `?cursor=${cursor}` : ""}`, headers: s.headers })).json();
  const mutate = async (s: Session, mutations: unknown[]) =>
    ctx.app.inject({ method: "POST", url: "/v1/sync/mutations", headers: s.headers, payload: { mutations } });

  it("applies an offline outbox in order and exactly once", async () => {
    const s = await login(ctx.app);
    const taskId = uuid();
    const noteId = uuid();
    const outbox = [
      { idempotencyKey: uuid(), type: "task.create", entityId: taskId, payload: { title: "Offline angelegt", priority: "important" } },
      { idempotencyKey: uuid(), type: "note.create", entityId: noteId, payload: { taskId, body: "Im Zug notiert" } },
      { idempotencyKey: uuid(), type: "task.update", entityId: taskId, baseVersion: 1, payload: { status: "doing" } },
    ];
    const first = await mutate(s, outbox);
    expect(first.statusCode).toBe(200);
    expect(first.json().results.map((r: { status: string }) => r.status)).toEqual(["applied", "applied", "applied"]);

    // The app lost the response and sends the same outbox again.
    const replay = await mutate(s, outbox);
    expect(replay.json().results).toEqual(first.json().results);

    const tasks = (await ctx.app.inject({ method: "GET", url: "/v1/tasks", headers: s.headers })).json().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: taskId, status: "doing", version: 2 });
  });

  it("delivers a snapshot, then only deltas with tombstones", async () => {
    const s = await login(ctx.app);
    const taskId = uuid();
    const noteId = uuid();
    await mutate(s, [
      { idempotencyKey: uuid(), type: "task.create", entityId: taskId, payload: { title: "A" } },
      { idempotencyKey: uuid(), type: "note.create", entityId: noteId, payload: { taskId, body: "n" } },
    ]);
    const snap = await changes(s);
    expect(snap.resetRequired).toBe(false);
    const types = snap.changes.map((c: { entityType: string }) => c.entityType).sort();
    expect(types).toEqual(["note", "settings", "task"]);

    const empty = await changes(s, snap.nextCursor);
    expect(empty.changes).toEqual([]);
    expect(empty.nextCursor).toBe(snap.nextCursor);

    await mutate(s, [
      { idempotencyKey: uuid(), type: "task.update", entityId: taskId, baseVersion: 1, payload: { title: "A2" } },
      { idempotencyKey: uuid(), type: "note.delete", entityId: noteId, baseVersion: 1 },
    ]);
    const delta = await changes(s, snap.nextCursor);
    const task = delta.changes.find((c: { entityType: string }) => c.entityType === "task");
    const note = delta.changes.find((c: { entityType: string }) => c.entityType === "note");
    expect(task).toMatchObject({ op: "upsert", entityId: taskId, version: 2 });
    expect(task.data.title).toBe("A2");
    expect(note).toMatchObject({ op: "delete", entityId: noteId, data: null });
    expect(BigInt(delta.nextCursor)).toBeGreaterThan(BigInt(snap.nextCursor));
  });

  it("pages through long histories", async () => {
    const s = await login(ctx.app);
    const snap = await changes(s);
    await mutate(
      s,
      Array.from({ length: 5 }, (_, i) => ({ idempotencyKey: uuid(), type: "task.create", entityId: uuid(), payload: { title: `T${i}` } })),
    );
    const page1 = (await ctx.app.inject({ method: "GET", url: `/v1/sync/changes?cursor=${snap.nextCursor}&limit=2`, headers: s.headers })).json();
    expect(page1.changes).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const rest = (await ctx.app.inject({ method: "GET", url: `/v1/sync/changes?cursor=${page1.nextCursor}&limit=10`, headers: s.headers })).json();
    expect(rest.changes).toHaveLength(3);
    expect(rest.hasMore).toBe(false);
  });

  it("keeps users apart and asks for a reset on unknown cursors", async () => {
    const a = await login(ctx.app);
    const b = await login(ctx.app);
    await mutate(a, [{ idempotencyKey: uuid(), type: "task.create", entityId: uuid(), payload: { title: "Nur A" } }]);
    const snapB = await changes(b);
    expect(snapB.changes.filter((c: { entityType: string }) => c.entityType === "task")).toEqual([]);

    const future = await changes(b, "999999999999");
    expect(future.resetRequired).toBe(true);
  });

  it("a key reused for another change is rejected, not applied", async () => {
    const s = await login(ctx.app);
    const key = uuid();
    const taskId = uuid();
    await mutate(s, [{ idempotencyKey: key, type: "task.create", entityId: taskId, payload: { title: "Eins" } }]);
    const res = await mutate(s, [{ idempotencyKey: key, type: "task.update", entityId: taskId, baseVersion: 1, payload: { title: "Zwei" } }]);
    expect(res.json().results[0]).toMatchObject({ status: "rejected", error: { code: "idempotency_key_reused" } });
  });
});

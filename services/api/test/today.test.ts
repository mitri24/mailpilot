import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Task } from "@mailpilot/contracts";
import { schema } from "@mailpilot/database";
import { addDays, dueDate, localDate, rankTask, sortForToday } from "../src/domain/today.js";
import { createTestContext, login, uuid, type Session, type TestContext } from "./helpers.js";

const TZ = "Europe/Paris";

describe("today ranking (pure)", () => {
  const base = (over: Partial<Task>): Task =>
    ({
      id: uuid(),
      status: "todo",
      waiting: false,
      snoozedUntil: null,
      plannedFor: null,
      sortKey: null,
      priority: "important",
      deadline: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...over,
    }) as Task;
  const dl = (date: string, kind: "explicit" | "uncertain" | "suggested" = "explicit") => ({ date, dateTime: null, precision: "date" as const, kind, sourceQuote: null });

  it("uses the local calendar date of a datetime deadline", () => {
    // 23:30 UTC on 29 March 2026 is already 30 March in Paris (summer time).
    const t = base({ deadline: { date: null, dateTime: "2026-03-29T23:30:00.000Z", precision: "datetime", kind: "explicit", sourceQuote: null } });
    expect(dueDate(t, TZ)).toBe("2026-03-30");
    expect(localDate(new Date("2026-03-29T23:30:00Z"), TZ)).toBe("2026-03-30");
  });

  it("suggested working dates are not deadlines", () => {
    const t = base({ priority: "can_wait", deadline: dl("2026-05-02", "suggested") });
    expect(rankTask(t, "2026-05-01", TZ)).toBe(4);
  });

  it("orders by evidenced deadline first, then manual order", () => {
    const today = "2026-05-01";
    const late = base({ deadline: dl("2026-05-03"), priority: "can_wait" });
    const overdue = base({ deadline: dl("2026-04-28"), priority: "can_wait" });
    const planned = base({ plannedFor: today });
    const crit2 = base({ priority: "critical", sortKey: 2 });
    const crit1 = base({ priority: "critical", sortKey: 1 });
    const later = base({ deadline: dl("2026-05-20") });
    const sorted = sortForToday([later, crit2, planned, late, crit1, overdue], today, TZ);
    expect(sorted).toEqual([overdue, late, planned, crit1, crit2, later]);
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("GET /v1/today", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());

  const create = async (s: Session, payload: Record<string, unknown>) =>
    (await ctx.app.inject({ method: "POST", url: "/v1/tasks", headers: s.headers, payload })).json() as Task;
  const patch = async (s: Session, t: Task, p: Record<string, unknown>) =>
    (await ctx.app.inject({ method: "PATCH", url: `/v1/tasks/${t.id}`, headers: s.headers, payload: { baseVersion: t.version, patch: p } })).json().task as Task;

  it("shows three next tasks, never hides further urgent ones", async () => {
    const s = await login(ctx.app);
    const today = localDate(new Date(), TZ);
    const date = (d: number) => ({ date: addDays(today, d), dateTime: null, precision: "date" });

    const important = await create(s, { title: "Wichtig ohne Frist" });
    const dueTomorrow = await create(s, { title: "Morgen fällig", priority: "can_wait", deadline: date(1) });
    const plannedTask = await create(s, { title: "Heute eingeplant" });
    await patch(s, plannedTask, { plannedFor: today });
    const critical = await create(s, { title: "Kritisch", priority: "critical" });
    const overdue = await create(s, { title: "Überfällig", priority: "can_wait", deadline: date(-1) });
    const waitingTask = await create(s, { title: "Warte", priority: "critical" });
    await patch(s, waitingTask, { waiting: true });
    const snoozed = await create(s, { title: "Später", priority: "critical" });
    await patch(s, snoozed, { snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() });
    const suggested = await create(s, { title: "Vorschlag" });
    await ctx.handle.db
      .update(schema.tasks)
      .set({ aiPriority: "can_wait", aiDeadlineDate: addDays(today, 1), aiDeadlinePrecision: "date", aiDeadlineKind: "suggested", manualPriority: null })
      .where(eq(schema.tasks.id, suggested.id));
    const critical2 = await create(s, { title: "Kritisch 2", priority: "critical" });
    const done = await create(s, { title: "Erledigt", priority: "critical" });
    await patch(s, done, { status: "done" });

    const res = await ctx.app.inject({ method: "GET", url: "/v1/today", headers: s.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next.map((t: Task) => t.title)).toEqual([overdue.title, dueTomorrow.title, plannedTask.title]);
    expect(body.moreUrgent.map((t: Task) => t.title)).toEqual([critical.title, critical2.title]);
    expect(body.waitingCount).toBe(1);
    expect(body.canWaitCount).toBe(1);
    const shown = [...body.next, ...body.moreUrgent].map((t: Task) => t.id);
    expect(shown).not.toContain(important.id);
    expect(shown).not.toContain(snoozed.id);
    expect(shown).not.toContain(done.id);
  });
});

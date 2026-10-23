import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, login, seedClarification, type Session, type TestContext } from "./helpers.js";

describe("clarifications and rules", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());

  const answer = (s: Session, id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({ method: "POST", url: `/v1/clarifications/${id}/answer`, headers: s.headers, payload });
  const rules = async (s: Session) => (await ctx.app.inject({ method: "GET", url: "/v1/rules", headers: s.headers })).json().rules;

  it("a one-off answer never creates a rule", async () => {
    const s = await login(ctx.app);
    const c = await seedClarification(ctx.handle, s.userId);
    const open = (await ctx.app.inject({ method: "GET", url: "/v1/clarifications", headers: s.headers })).json().clarifications;
    expect(open.map((x: { id: string }) => x.id)).toEqual([c.id]);

    const res = await answer(s, c.id, { optionId: "not_this_time", scope: "permanent" });
    expect(res.json().result.status).toBe("applied");
    expect(res.json().clarification.answer).toMatchObject({ optionId: "not_this_time", scope: "once" });
    expect(await rules(s)).toEqual([]);
    expect(ctx.queue.jobs.some((j) => j.name === "apply_clarification" && (j.payload as { clarificationId: string }).clarificationId === c.id)).toBe(true);
  });

  it("a permanent answer creates a visible, editable, deletable rule", async () => {
    const s = await login(ctx.app);
    const c = await seedClarification(ctx.handle, s.userId);
    await answer(s, c.id, { optionId: "yes", scope: "permanent" });
    const [rule] = await rules(s);
    expect(rule).toMatchObject({ kind: "membership", subject: "B2", value: { applies: true }, sourceClarificationId: c.id });
    expect(rule.description).toContain("B2");

    const edited = await ctx.app.inject({ method: "PATCH", url: `/v1/rules/${rule.id}`, headers: s.headers, payload: { applies: false } });
    expect(edited.json().value.applies).toBe(false);

    const del = await ctx.app.inject({ method: "DELETE", url: `/v1/rules/${rule.id}`, headers: s.headers });
    expect(del.statusCode).toBe(200);
    expect(await rules(s)).toEqual([]);
  });

  it("the default scope is once", async () => {
    const s = await login(ctx.app);
    const c = await seedClarification(ctx.handle, s.userId);
    await answer(s, c.id, { optionId: "yes" });
    expect(await rules(s)).toEqual([]);
  });

  it("a second, different answer is a conflict; the same answer is idempotent", async () => {
    const s = await login(ctx.app);
    const c = await seedClarification(ctx.handle, s.userId);
    await answer(s, c.id, { optionId: "no", scope: "once" });
    expect((await answer(s, c.id, { optionId: "no", scope: "once" })).json().result.status).toBe("applied");
    expect((await answer(s, c.id, { optionId: "yes", scope: "once" })).json().result.status).toBe("conflict");
  });

  it("rejects unknown options and free text where none is allowed", async () => {
    const s = await login(ctx.app);
    const c = await seedClarification(ctx.handle, s.userId);
    expect((await answer(s, c.id, { optionId: "maybe" })).json().result.error.code).toBe("invalid_option");
    expect((await answer(s, c.id, { text: "egal" })).json().result.error.code).toBe("free_text_not_allowed");
    expect((await answer(s, c.id, {})).statusCode).toBe(400);
  });
});

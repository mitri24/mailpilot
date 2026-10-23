import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inQuietHours, localMonthStart, startOfLocalDay } from "@mailpilot/contracts";
import { schema } from "@mailpilot/database";
import { FakeMailbox } from "./fake-mailbox.js";
import { createHarness, imapCaps, selectDefaultFolders, type Harness } from "./harness.js";

const { processingRuns, notificationsSent, tasks, clarificationRequests } = schema;

describe("time helpers", () => {
  it("finds local midnight across daylight saving changes", () => {
    expect(startOfLocalDay("2026-03-29", "Europe/Paris").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(startOfLocalDay("2026-03-30", "Europe/Paris").toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(startOfLocalDay("2026-10-26", "Europe/Paris").toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(localMonthStart(new Date("2026-11-01T00:30:00+01:00"), "Europe/Paris")).toEqual({ month: "2026-11", start: new Date("2026-10-31T23:00:00.000Z") });
  });

  it("handles quiet hours across midnight", () => {
    expect(inQuietHours("23:30", "22:00", "07:00")).toBe(true);
    expect(inQuietHours("06:59", "22:00", "07:00")).toBe(true);
    expect(inQuietHours("07:00", "22:00", "07:00")).toBe(false);
    expect(inQuietHours("12:00", "12:00", "13:00")).toBe(true);
    expect(inQuietHours("12:00", null, null)).toBe(false);
  });
});

describe("scheduled tick", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  async function user(over: Partial<typeof schema.users.$inferInsert> = {}) {
    const u = await h.createUser(over);
    const box = new FakeMailbox(imapCaps());
    const account = await h.createAccount(u.id, box);
    await selectDefaultFolders(h, account);
    return { u, account };
  }
  const runsOf = (accountId: string) => h.handle.db.select().from(processingRuns).where(eq(processingRuns.accountId, accountId));
  const tick = async () => {
    await h.deps.enqueue("scheduled_scans", {});
    await h.drain();
  };

  it("scans once per day at the user's local scan time (default 07:00 Europe/Paris)", async () => {
    const { account } = await user();
    h.clock.now = new Date("2026-10-23T06:55:00+02:00");
    await tick();
    expect(await runsOf(account.id)).toHaveLength(0);
    h.clock.now = new Date("2026-10-23T07:05:00+02:00");
    await tick();
    await tick();
    const runs = await runsOf(account.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "schedule", status: "succeeded" });
    h.clock.now = new Date("2026-10-24T07:01:00+02:00");
    await tick();
    expect(await runsOf(account.id)).toHaveLength(2);
  });

  it("paused accounts and disabled scans are left alone", async () => {
    const { account } = await user({ scanEnabled: false });
    const other = await user();
    await h.handle.db.update(schema.mailAccounts).set({ status: "paused" }).where(eq(schema.mailAccounts.id, other.account.id));
    h.clock.now = new Date("2026-10-25T09:00:00+01:00");
    await tick();
    expect(await runsOf(account.id)).toHaveLength(0);
    expect(await runsOf(other.account.id)).toHaveLength(0);
  });

  it("optional extra scans follow the configured interval", async () => {
    const { account } = await user({ extraScanIntervalMinutes: 60, lastScheduledScanOn: "2026-10-26" });
    h.clock.now = new Date("2026-10-26T10:00:00+01:00");
    await tick();
    expect(await runsOf(account.id)).toHaveLength(1);
    h.clock.now = new Date("2026-10-26T10:30:00+01:00");
    await tick();
    expect(await runsOf(account.id)).toHaveLength(1);
    h.clock.now = new Date("2026-10-26T11:05:00+01:00");
    await tick();
    expect(await runsOf(account.id)).toHaveLength(2);
  });

  it("notifications are opt-in, bundled, deduplicated and respect quiet hours", async () => {
    const { u } = await user({
      notifyDailyDigest: true,
      notifyUrgentDeadlines: true,
      notifyClarifications: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      scanEnabled: false,
    });
    await h.handle.db.insert(tasks).values([
      { userId: u.id, origin: "ai", aiTitle: "Formular abgeben", aiDeadlineDate: "2026-10-28", aiDeadlinePrecision: "date", aiDeadlineKind: "explicit" },
      { userId: u.id, origin: "ai", aiTitle: "Vorschlag", aiDeadlineDate: "2026-10-28", aiDeadlinePrecision: "date", aiDeadlineKind: "suggested" },
    ]);
    await h.handle.db.insert(clarificationRequests).values({ userId: u.id, kind: "membership", question: "Gehörst du zu B2?", reason: "x", subject: "B2", options: [], dedupeKey: "membership:b2:test" });

    const before = h.notifier.sent.length;
    h.clock.now = new Date("2026-10-27T23:00:00+01:00"); // quiet hours
    await tick();
    expect(h.notifier.sent.length).toBe(before);

    h.clock.now = new Date("2026-10-28T08:00:00+01:00");
    await tick();
    const mine = h.notifier.sent.filter((s) => s.userId === u.id).map((s) => s.message);
    expect(mine.map((m) => m.kind).sort()).toEqual(["clarifications", "digest", "urgent"]);
    expect(mine.find((m) => m.kind === "urgent")!.body).toContain("Formular abgeben");
    expect(mine.find((m) => m.kind === "urgent")!.body).not.toContain("Vorschlag");

    await tick();
    expect(h.notifier.sent.filter((s) => s.userId === u.id)).toHaveLength(3);
    const recorded = await h.handle.db.select().from(notificationsSent).where(eq(notificationsSent.userId, u.id));
    expect(recorded.every((r) => r.status === "sent")).toBe(true);
  });

  it("users without opt-in get no push at all", async () => {
    const { u } = await user({ scanEnabled: false });
    await h.handle.db.insert(tasks).values({ userId: u.id, origin: "ai", aiTitle: "Frist", aiDeadlineDate: "2026-10-28", aiDeadlinePrecision: "date", aiDeadlineKind: "explicit" });
    h.clock.now = new Date("2026-10-28T09:00:00+01:00");
    await tick();
    expect(h.notifier.sent.filter((s) => s.userId === u.id)).toHaveLength(0);
  });
});

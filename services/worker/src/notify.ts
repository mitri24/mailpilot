import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { importPKCS8, SignJWT } from "jose";
import { addDays, inQuietHours, localDate, localTime } from "@mailpilot/contracts";
import { schema, type Database } from "@mailpilot/database";
import type { Notifier, PushMessage, UserRow, WorkerDeps } from "./deps.js";

const { tasks, clarificationRequests, notificationsSent, pushDevices, users, messages, mailAccounts } = schema;

const addMinutes = (time: string, minutes: number) => {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** Records the dedupe key first; only a newly recorded key leads to a push. */
async function claim(db: Database, userId: string, kind: string, dedupeKey: string): Promise<string | null> {
  const [row] = await db.insert(notificationsSent).values({ userId, kind, dedupeKey, status: "pending" }).onConflictDoNothing().returning({ id: notificationsSent.id });
  return row?.id ?? null;
}

async function deliver(deps: WorkerDeps, userId: string, ids: string[], message: PushMessage): Promise<void> {
  const result = await deps.notifier.send(userId, message);
  await deps.db.update(notificationsSent).set({ status: result.status, detail: result.detail }).where(inArray(notificationsSent.id, ids));
}

/**
 * Opt-in notifications only: a daily digest, evidenced urgent deadlines and one bundled hint on
 * open questions. Never one push per new task; quiet hours are respected; everything is deduplicated.
 */
export async function runNotifications(deps: WorkerDeps, user: UserRow, now: Date): Promise<void> {
  if (!user.notifyDailyDigest && !user.notifyUrgentDeadlines && !user.notifyClarifications) return;
  const time = localTime(now, user.timezone);
  if (inQuietHours(time, user.quietHoursStart, user.quietHoursEnd)) return;
  const today = localDate(now, user.timezone);
  const tomorrow = addDays(today, 1);
  const tz = user.timezone;

  // Evidenced deadlines only: manual deadlines and explicit or uncertain AI deadlines, never suggestions.
  const due = sql<string | null>`case when ${tasks.manualDeadlineCleared} then null else coalesce(${tasks.manualDeadlineDate}, (${tasks.manualDeadlineAt} at time zone ${tz})::date, case when ${tasks.aiDeadlineKind} = 'suggested' then null else coalesce(${tasks.aiDeadlineDate}, (${tasks.aiDeadlineAt} at time zone ${tz})::date) end) end`;
  const open = and(eq(tasks.userId, user.id), inArray(tasks.status, ["todo", "doing"]), isNull(tasks.deletedAt), isNull(tasks.mergedIntoTaskId));

  if (user.notifyDailyDigest && time >= addMinutes(user.scanTime, 30) && user.lastDigestSentOn !== today) {
    const claimed = await deps.db
      .update(users)
      .set({ lastDigestSentOn: today })
      .where(and(eq(users.id, user.id), or(isNull(users.lastDigestSentOn), sql`${users.lastDigestSentOn} <> ${today}`)))
      .returning({ id: users.id });
    if (claimed.length > 0) {
      const [urgent] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(open, sql`${due} <= ${addDays(today, 2)}::date`));
      const [questions] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(clarificationRequests)
        .where(and(eq(clarificationRequests.userId, user.id), eq(clarificationRequests.status, "open")));
      const [pending] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
        .where(and(eq(mailAccounts.userId, user.id), inArray(messages.analysisStatus, ["pending", "budget_paused", "failed"]), isNull(messages.deletedAt)));
      const parts = [
        `${urgent?.n ?? 0} dringende Fristen`,
        `${questions?.n ?? 0} offene Rückfragen`,
        ...(pending && pending.n > 0 ? [`${pending.n} Mails noch ungeprüft`] : []),
      ];
      const id = await claim(deps.db, user.id, "digest", `digest:${today}`);
      if (id) await deliver(deps, user.id, [id], { kind: "digest", title: "MailPilot – heute", body: parts.join(" · "), deepLink: "mailpilot://today" });
    }
  }

  if (user.notifyUrgentDeadlines) {
    const rows = await deps.db
      .select({ id: tasks.id, title: sql<string>`coalesce(${tasks.manualTitle}, ${tasks.aiTitle}, 'Aufgabe')`, due })
      .from(tasks)
      .where(and(open, sql`${due} is not null`, lte(sql`${due}`, sql`${tomorrow}::date`)));
    const fresh: Array<{ id: string; title: string; claimId: string }> = [];
    for (const r of rows) {
      const claimId = await claim(deps.db, user.id, "urgent", `urgent:${r.id}:${r.due}`);
      if (claimId) fresh.push({ id: r.id, title: r.title, claimId });
    }
    if (fresh.length > 0) {
      const body = fresh.length === 1 ? `Frist bis spätestens morgen: ${fresh[0]!.title}` : `${fresh.length} Fristen bis spätestens morgen: ${fresh.map((f) => f.title).slice(0, 3).join(", ")}`;
      await deliver(deps, user.id, fresh.map((f) => f.claimId), {
        kind: "urgent",
        title: "Dringende Frist",
        body,
        deepLink: fresh.length === 1 ? `mailpilot://tasks/${fresh[0]!.id}` : "mailpilot://today",
      });
    }
  }

  if (user.notifyClarifications) {
    const openQuestions = await deps.db
      .select({ id: clarificationRequests.id })
      .from(clarificationRequests)
      .where(
        and(
          eq(clarificationRequests.userId, user.id),
          eq(clarificationRequests.status, "open"),
          isNull(clarificationRequests.answerOptionId), // deferred ("Weiß ich noch nicht") ones are not pushed again
          gte(clarificationRequests.createdAt, new Date(now.getTime() - 14 * 86_400_000)),
        ),
      );
    if (openQuestions.length > 0) {
      const notified = await deps.db
        .select({ key: notificationsSent.dedupeKey })
        .from(notificationsSent)
        .where(and(eq(notificationsSent.userId, user.id), inArray(notificationsSent.dedupeKey, openQuestions.map((q) => `clar:${q.id}`))));
      const known = new Set(notified.map((n) => n.key));
      const unseen = openQuestions.filter((q) => !known.has(`clar:${q.id}`));
      if (unseen.length > 0) {
        const bundle = await claim(deps.db, user.id, "clarifications", `clarifications:${today}`);
        if (bundle) {
          const ids = [bundle];
          for (const q of unseen) {
            const id = await claim(deps.db, user.id, "clarification", `clar:${q.id}`);
            if (id) ids.push(id);
          }
          await deliver(deps, user.id, ids, {
            kind: "clarifications",
            title: "Rückfragen",
            body: unseen.length === 1 ? "Eine neue Rückfrage wartet auf dich." : `${unseen.length} neue Rückfragen warten auf dich.`,
            deepLink: "mailpilot://clarifications",
          });
        }
      }
    }
  }
}

/** Used when APNs is not configured: notifications are recorded as skipped, the app works fully without push. */
export class NoopNotifier implements Notifier {
  async send() {
    return { status: "skipped" as const, detail: "APNs ist nicht eingerichtet" };
  }
}

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKeyPath: string;
  topic: string;
}

/**
 * Token-based APNs (HTTP/2, ES256 provider token, refreshed well within its one-hour validity).
 * Device tokens that APNs reports as unregistered are disabled.
 */
export class ApnsNotifier implements Notifier {
  private token: { value: string; issuedAt: number } | null = null;
  private sessions = new Map<string, ClientHttp2Session>();

  constructor(
    private readonly config: ApnsConfig,
    private readonly db: Database,
  ) {}

  private async providerToken(): Promise<string> {
    if (this.token && Date.now() - this.token.issuedAt < 40 * 60_000) return this.token.value;
    const key = await importPKCS8(readFileSync(this.config.privateKeyPath, "utf8"), "ES256");
    const value = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: this.config.keyId }).setIssuer(this.config.teamId).setIssuedAt().sign(key);
    this.token = { value, issuedAt: Date.now() };
    return value;
  }

  private session(host: string): ClientHttp2Session {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(`https://${host}`);
    s.on("error", () => this.sessions.delete(host));
    s.on("close", () => this.sessions.delete(host));
    this.sessions.set(host, s);
    return s;
  }

  private post(host: string, deviceToken: string, headers: Record<string, string>, body: string): Promise<{ status: number; reason: string | null }> {
    return new Promise((resolve, reject) => {
      const req = this.session(host).request({ ":method": "POST", ":path": `/3/device/${deviceToken}`, ...headers });
      let status = 0;
      let data = "";
      req.setEncoding("utf8");
      req.on("response", (h) => (status = Number(h[":status"] ?? 0)));
      req.on("data", (chunk: string) => (data += chunk));
      req.on("end", () => {
        let reason: string | null = null;
        try {
          reason = data ? ((JSON.parse(data) as { reason?: string }).reason ?? null) : null;
        } catch {
          reason = null;
        }
        resolve({ status, reason });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => req.close());
      req.end(body);
    });
  }

  async send(userId: string, message: PushMessage) {
    const devices = await this.db.select().from(pushDevices).where(and(eq(pushDevices.userId, userId), isNull(pushDevices.disabledAt)));
    if (devices.length === 0) return { status: "skipped" as const, detail: "Kein Gerät für Mitteilungen registriert" };
    const token = await this.providerToken();
    const payload = JSON.stringify({ aps: { alert: { title: message.title, body: message.body }, "thread-id": message.kind }, deepLink: message.deepLink });
    let sent = 0;
    const errors: string[] = [];
    for (const d of devices) {
      const host = d.environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
      try {
        const res = await this.post(
          host,
          d.token,
          {
            authorization: `bearer ${token}`,
            "apns-topic": this.config.topic,
            "apns-push-type": "alert",
            "apns-priority": "5",
            "apns-collapse-id": message.kind,
          },
          payload,
        );
        if (res.status === 200) sent++;
        else {
          errors.push(`${res.status} ${res.reason ?? ""}`.trim());
          if (res.status === 410 || res.reason === "BadDeviceToken" || res.reason === "Unregistered") {
            await this.db.update(pushDevices).set({ disabledAt: new Date() }).where(eq(pushDevices.id, d.id));
          }
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return sent > 0 ? { status: "sent" as const, detail: errors.length ? errors.join("; ") : null } : { status: "failed" as const, detail: errors.join("; ") || null };
  }

  close() {
    for (const s of this.sessions.values()) s.close();
  }
}

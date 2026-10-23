import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  Clarification,
  ClarificationAnswer,
  ClarificationStatus,
  ErrorBody,
  MutationResult,
  PushRegistration,
  Rule,
  RulePatch,
  ScanRequest,
  ScanRun,
  Settings,
  SettingsPatch,
  Today,
  Usage,
} from "@mailpilot/contracts";
import { recordChange, schema, userTransaction, type Database } from "@mailpilot/database";
import { badRequest, notFound } from "../errors.js";
import type { JobQueue } from "../queue.js";
import { toClarificationDto, toRuleDto, toSettingsDto } from "../domain/dto.js";
import { applyMutation } from "../domain/mutations.js";
import { getRun, listRuns, requestScan } from "../domain/scans.js";
import { computeToday } from "../domain/today.js";
import { getUsage } from "../domain/usage.js";
import { authOf, idempotencyKeyOf, type Router } from "./types.js";

const { users, clarificationRequests, userRules, pushDevices } = schema;
const IdParam = z.object({ id: z.uuid() });

export function registerMiscRoutes(r: Router, deps: { db: Database; queue: JobQueue }) {
  const { db, queue } = deps;

  r.get("/v1/today", { schema: { tags: ["today"], summary: "Tagesansicht: drei nächste Aufgaben, weitere dringende, Rückfragen", response: { 200: Today } } }, async (request) => {
    const { userId } = authOf(request);
    const [user] = await db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId));
    return computeToday(db, userId, user?.tz ?? "Europe/Paris");
  });

  // ----------------------------------------------------------- clarifications

  r.get(
    "/v1/clarifications",
    {
      schema: {
        tags: ["clarifications"],
        summary: "Gebündelte Rückfragen",
        querystring: z.object({ status: ClarificationStatus.default("open") }),
        response: { 200: z.object({ clarifications: z.array(Clarification) }) },
      },
    },
    async (request) => {
      const rows = await db
        .select()
        .from(clarificationRequests)
        .where(and(eq(clarificationRequests.userId, authOf(request).userId), eq(clarificationRequests.status, request.query.status)))
        .orderBy(desc(clarificationRequests.createdAt))
        .limit(200);
      return { clarifications: rows.map(toClarificationDto) };
    },
  );

  r.post(
    "/v1/clarifications/:id/answer",
    {
      schema: {
        tags: ["clarifications"],
        summary: "Rückfrage beantworten; „einmalig“ erzeugt nie eine dauerhafte Regel",
        params: IdParam,
        body: ClarificationAnswer,
        response: { 200: z.object({ result: MutationResult, clarification: Clarification.nullable() }) },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const result = await applyMutation(db, queue, userId, {
        idempotencyKey: idempotencyKeyOf(request) ?? randomUUID(),
        type: "clarification.answer",
        entityId: request.params.id,
        payload: { optionId: request.body.optionId ?? null, text: request.body.text ?? null, scope: request.body.scope },
      });
      const [row] = await db.select().from(clarificationRequests).where(and(eq(clarificationRequests.id, request.params.id), eq(clarificationRequests.userId, userId)));
      return { result, clarification: row ? toClarificationDto(row) : null };
    },
  );

  // ----------------------------------------------------------- rules

  r.get("/v1/rules", { schema: { tags: ["rules"], summary: "Dauerhafte Zuordnungen (sichtbar, änderbar, löschbar)", response: { 200: z.object({ rules: z.array(Rule) }) } } }, async (request) => {
    const rows = await db
      .select()
      .from(userRules)
      .where(and(eq(userRules.userId, authOf(request).userId), isNull(userRules.deletedAt)))
      .orderBy(desc(userRules.updatedAt));
    return { rules: rows.map(toRuleDto) };
  });

  r.patch(
    "/v1/rules/:id",
    { schema: { tags: ["rules"], summary: "Zuordnung ändern", params: IdParam, body: RulePatch, response: { 200: Rule, 404: ErrorBody } } },
    async (request) => {
      const { userId } = authOf(request);
      return userTransaction(db, userId, async (tx) => {
        const [row] = await tx.select().from(userRules).where(and(eq(userRules.id, request.params.id), eq(userRules.userId, userId), isNull(userRules.deletedAt))).for("update");
        if (!row) throw notFound("Zuordnung");
        const version = row.version + 1;
        const [updated] = await tx
          .update(userRules)
          .set({
            ...(request.body.applies !== undefined ? { applies: request.body.applies } : {}),
            ...(request.body.note !== undefined ? { note: request.body.note } : {}),
            version,
            updatedAt: new Date(),
          })
          .where(eq(userRules.id, row.id))
          .returning();
        await recordChange(tx, { userId, entityType: "rule", entityId: row.id, op: "upsert", version });
        return toRuleDto(updated!);
      });
    },
  );

  r.delete(
    "/v1/rules/:id",
    { schema: { tags: ["rules"], summary: "Zuordnung löschen", params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (request) => {
      const { userId } = authOf(request);
      await userTransaction(db, userId, async (tx) => {
        const [row] = await tx.select().from(userRules).where(and(eq(userRules.id, request.params.id), eq(userRules.userId, userId), isNull(userRules.deletedAt))).for("update");
        if (!row) return;
        const version = row.version + 1;
        await tx.update(userRules).set({ deletedAt: new Date(), version, updatedAt: new Date() }).where(eq(userRules.id, row.id));
        await recordChange(tx, { userId, entityType: "rule", entityId: row.id, op: "delete", version });
      });
      return { ok: true };
    },
  );

  // ----------------------------------------------------------- settings & usage

  r.get("/v1/settings", { schema: { tags: ["settings"], summary: "Einstellungen", response: { 200: Settings } } }, async (request) => {
    const [user] = await db.select().from(users).where(eq(users.id, authOf(request).userId));
    if (!user) throw notFound("Benutzer");
    return toSettingsDto(user);
  });

  r.patch(
    "/v1/settings",
    { schema: { tags: ["settings"], summary: "Einstellungen ändern (Scanzeit, Budget, Benachrichtigungen)", body: SettingsPatch, response: { 200: Settings } } },
    async (request) => {
      const { userId } = authOf(request);
      const p = request.body;
      if (p.timezone) {
        try {
          new Intl.DateTimeFormat("de-DE", { timeZone: p.timezone });
        } catch {
          throw badRequest("Unbekannte Zeitzone");
        }
      }
      return userTransaction(db, userId, async (tx) => {
        const [current] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
        if (!current) throw notFound("Benutzer");
        const version = current.settingsVersion + 1;
        const [updated] = await tx
          .update(users)
          .set({ ...p, settingsVersion: version, updatedAt: new Date() })
          .where(eq(users.id, userId))
          .returning();
        await recordChange(tx, { userId, entityType: "settings", entityId: userId, op: "upsert", version });
        return toSettingsDto(updated!);
      });
    },
  );

  r.get("/v1/usage", { schema: { tags: ["settings"], summary: "KI-Verbrauch im laufenden Monat und ungeprüfte Mails", response: { 200: Usage } } }, async (request) =>
    getUsage(db, authOf(request).userId),
  );

  // ----------------------------------------------------------- scans

  r.post(
    "/v1/scans",
    { schema: { tags: ["scans"], summary: "Scan jetzt auslösen (alle aktiven Konten oder eines)", body: ScanRequest, response: { 200: z.object({ runs: z.array(ScanRun) }), 409: ErrorBody } } },
    async (request) => ({ runs: await requestScan(db, queue, authOf(request).userId, request.body.accountId) }),
  );

  r.get(
    "/v1/scans",
    { schema: { tags: ["scans"], summary: "Letzte Läufe", querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), response: { 200: z.object({ runs: z.array(ScanRun) }) } } },
    async (request) => ({ runs: await listRuns(db, authOf(request).userId, request.query.limit) }),
  );

  r.get("/v1/scans/:id", { schema: { tags: ["scans"], summary: "Status eines Laufs", params: IdParam, response: { 200: ScanRun, 404: ErrorBody } } }, async (request) =>
    getRun(db, authOf(request).userId, request.params.id),
  );

  // ----------------------------------------------------------- push

  r.post(
    "/v1/devices/push",
    { schema: { tags: ["devices"], summary: "APNs-Token registrieren (optional)", body: PushRegistration, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (request) => {
      const { userId } = authOf(request);
      await db
        .insert(pushDevices)
        .values({ userId, token: request.body.token, environment: request.body.environment, platform: request.body.platform })
        .onConflictDoUpdate({
          target: pushDevices.token,
          set: { userId, environment: request.body.environment, platform: request.body.platform, updatedAt: new Date(), disabledAt: null },
        });
      return { ok: true };
    },
  );
}

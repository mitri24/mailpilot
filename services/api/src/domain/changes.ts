import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Change, ChangesResponse, SyncEntityType } from "@mailpilot/contracts";
import { schema, type Database, type Executor } from "@mailpilot/database";
import { toChecklistDto, toClarificationDto, toNoteDto, toRuleDto, toSettingsDto } from "./dto.js";
import { loadAccountDtos } from "./accounts-query.js";
import { tasksToDto } from "./task-queries.js";

const { changeLog, tasks, taskNotes, taskChecklistItems, clarificationRequests, userRules, users } = schema;

interface Ref {
  seq: bigint;
  entityType: SyncEntityType;
  entityId: string;
  op: "upsert" | "delete";
  version: number;
}

/**
 * Delta sync: change-log entries after `cursor`, each carrying the entity's current state
 * (or a tombstone). Without a cursor the client gets a full snapshot and the current cursor.
 */
export async function getChanges(db: Database, userId: string, cursor: string | undefined, limit: number): Promise<ChangesResponse> {
  // One consistent read: the cursor and the entity states come from the same database snapshot.
  return db.transaction((tx) => (cursor === undefined ? snapshot(tx, userId) : delta(tx, userId, cursor, limit)), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

async function delta(db: Executor, userId: string, cursor: string, limit: number): Promise<ChangesResponse> {
  const [head] = await db.select({ max: sql<string | null>`max(${changeLog.seq})::text` }).from(changeLog);
  if (BigInt(cursor) > BigInt(head?.max ?? "0")) {
    // A cursor this database never issued (e.g. after a reset) cannot be continued.
    return { changes: [], nextCursor: "0", hasMore: false, resetRequired: true, serverTime: new Date().toISOString() };
  }

  const rows = await db
    .select()
    .from(changeLog)
    .where(and(eq(changeLog.userId, userId), gt(changeLog.seq, BigInt(cursor))))
    .orderBy(asc(changeLog.seq))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = page.length > 0 ? page[page.length - 1]!.seq.toString() : cursor;

  // Only the newest entry per entity matters; the payload is the current state anyway.
  const latest = new Map<string, Ref>();
  for (const r of page) {
    latest.set(`${r.entityType}:${r.entityId}`, {
      seq: r.seq,
      entityType: r.entityType as SyncEntityType,
      entityId: r.entityId,
      op: r.op as Ref["op"],
      version: r.version,
    });
  }
  const changes = await materialize(db, userId, [...latest.values()].sort((a, b) => (a.seq < b.seq ? -1 : 1)));
  return { changes, nextCursor, hasMore, resetRequired: false, serverTime: new Date().toISOString() };
}

async function snapshot(db: Executor, userId: string): Promise<ChangesResponse> {
  const maxRow = await db
    .select({ max: sql<string | null>`max(${changeLog.seq})::text` })
    .from(changeLog)
    .where(eq(changeLog.userId, userId));
  const cursor = maxRow[0]?.max ?? "0";
  const seq = BigInt(cursor);
  const refs: Ref[] = [];
  const push = (entityType: SyncEntityType, list: Array<{ id: string; version: number }>) => {
    for (const e of list) refs.push({ seq, entityType, entityId: e.id, op: "upsert", version: e.version });
  };
  push("settings", await db.select({ id: users.id, version: users.settingsVersion }).from(users).where(eq(users.id, userId)));
  push(
    "account",
    await db
      .select({ id: schema.mailAccounts.id, version: schema.mailAccounts.version })
      .from(schema.mailAccounts)
      .where(and(eq(schema.mailAccounts.userId, userId), isNull(schema.mailAccounts.removedAt))),
  );
  push("task", await db.select({ id: tasks.id, version: tasks.version }).from(tasks).where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt))));
  push(
    "note",
    await db.select({ id: taskNotes.id, version: taskNotes.version }).from(taskNotes).where(and(eq(taskNotes.userId, userId), isNull(taskNotes.deletedAt))),
  );
  push(
    "checklist_item",
    await db
      .select({ id: taskChecklistItems.id, version: taskChecklistItems.version })
      .from(taskChecklistItems)
      .innerJoin(tasks, eq(tasks.id, taskChecklistItems.taskId))
      .where(and(eq(tasks.userId, userId), isNull(taskChecklistItems.deletedAt))),
  );
  push(
    "clarification",
    await db
      .select({ id: clarificationRequests.id, version: clarificationRequests.version })
      .from(clarificationRequests)
      .where(eq(clarificationRequests.userId, userId)),
  );
  push("rule", await db.select({ id: userRules.id, version: userRules.version }).from(userRules).where(and(eq(userRules.userId, userId), isNull(userRules.deletedAt))));
  const changes = await materialize(db, userId, refs);
  return { changes, nextCursor: cursor, hasMore: false, resetRequired: false, serverTime: new Date().toISOString() };
}

async function materialize(db: Executor, userId: string, refs: Ref[]): Promise<Change[]> {
  const idsOf = (t: SyncEntityType) => refs.filter((r) => r.entityType === t).map((r) => r.entityId);

  const taskIds = idsOf("task");
  const taskRows = taskIds.length ? await db.select().from(tasks).where(and(inArray(tasks.id, taskIds), eq(tasks.userId, userId))) : [];
  const taskDtos = new Map((await tasksToDto(db, taskRows.filter((t) => !t.deletedAt))).map((t) => [t.id, t]));

  const noteIds = idsOf("note");
  const notes = new Map(
    (noteIds.length ? await db.select().from(taskNotes).where(and(inArray(taskNotes.id, noteIds), eq(taskNotes.userId, userId))) : [])
      .filter((n) => !n.deletedAt)
      .map((n) => [n.id, toNoteDto(n)]),
  );

  const checklistIds = idsOf("checklist_item");
  const checklist = new Map(
    (checklistIds.length
      ? await db
          .select({ item: taskChecklistItems })
          .from(taskChecklistItems)
          .innerJoin(tasks, eq(tasks.id, taskChecklistItems.taskId))
          .where(and(inArray(taskChecklistItems.id, checklistIds), eq(tasks.userId, userId)))
      : []
    )
      .filter((r) => !r.item.deletedAt)
      .map((r) => [r.item.id, toChecklistDto(r.item)]),
  );

  const clarIds = idsOf("clarification");
  const clarifications = new Map(
    (clarIds.length
      ? await db.select().from(clarificationRequests).where(and(inArray(clarificationRequests.id, clarIds), eq(clarificationRequests.userId, userId)))
      : []
    ).map((c) => [c.id, toClarificationDto(c)]),
  );

  const ruleIds = idsOf("rule");
  const rules = new Map(
    (ruleIds.length ? await db.select().from(userRules).where(and(inArray(userRules.id, ruleIds), eq(userRules.userId, userId))) : [])
      .filter((r) => !r.deletedAt)
      .map((r) => [r.id, toRuleDto(r)]),
  );

  const accountIds = idsOf("account");
  const accounts = new Map((accountIds.length ? await loadAccountDtos(db, userId, accountIds) : []).map((a) => [a.id, a]));

  const settingsRows = idsOf("settings").length ? await db.select().from(users).where(eq(users.id, userId)) : [];
  const settings = settingsRows[0] ? toSettingsDto(settingsRows[0]) : null;

  const changes: Change[] = [];
  for (const r of refs) {
    const seq = r.seq.toString();
    const base = { seq, entityId: r.entityId };
    switch (r.entityType) {
      case "task": {
        const data = taskDtos.get(r.entityId) ?? null;
        changes.push({ ...base, entityType: "task", op: data ? "upsert" : "delete", version: data?.version ?? r.version, data });
        break;
      }
      case "note": {
        const data = notes.get(r.entityId) ?? null;
        changes.push({ ...base, entityType: "note", op: data ? "upsert" : "delete", version: data?.version ?? r.version, data });
        break;
      }
      case "checklist_item": {
        const data = checklist.get(r.entityId) ?? null;
        changes.push({ ...base, entityType: "checklist_item", op: data ? "upsert" : "delete", version: data?.version ?? r.version, data });
        break;
      }
      case "clarification": {
        const data = clarifications.get(r.entityId) ?? null;
        changes.push({ ...base, entityType: "clarification", op: data ? "upsert" : "delete", version: data?.version ?? r.version, data });
        break;
      }
      case "rule": {
        const data = rules.get(r.entityId) ?? null;
        changes.push({ ...base, entityType: "rule", op: data ? "upsert" : "delete", version: data?.version ?? r.version, data });
        break;
      }
      case "account": {
        const dto = accounts.get(r.entityId);
        // A removed account is a tombstone for clients.
        const data = dto && dto.status !== "removed" ? dto : null;
        changes.push({ ...base, entityType: "account", op: data ? "upsert" : "delete", version: data?.version ?? r.version, data });
        break;
      }
      case "settings":
        changes.push({ ...base, entityType: "settings", op: settings ? "upsert" : "delete", version: settings?.version ?? r.version, data: settings });
        break;
    }
  }
  return changes;
}

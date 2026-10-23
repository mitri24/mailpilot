import { and, desc, eq, ilike, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { MessageDetail, MessageSummary } from "@mailpilot/contracts";
import { schema, type Executor } from "@mailpilot/database";
import { notFound } from "../errors.js";
import { iso } from "./dto.js";

const { messages, mailAccounts, taskSources, messageLocations, mailFolders, markerOperations } = schema;

type MessageRow = typeof messages.$inferSelect;

async function summaries(db: Executor, rows: MessageRow[]): Promise<MessageSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const links = await db
    .select({ messageId: taskSources.messageId, taskId: taskSources.taskId })
    .from(taskSources)
    .where(and(inArray(taskSources.messageId, ids), isNull(taskSources.removedAt)));
  const folders = await db
    .select({ messageId: messageLocations.messageId, name: mailFolders.name })
    .from(messageLocations)
    .innerJoin(mailFolders, eq(mailFolders.id, messageLocations.folderId))
    .where(and(inArray(messageLocations.messageId, ids), eq(messageLocations.present, true)));
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    subject: r.subject,
    from: r.fromAddress ? { name: r.fromName, address: r.fromAddress } : null,
    sentAt: iso(r.sentAt),
    snippet: r.snippet,
    language: r.language,
    hasAttachments: r.hasAttachments,
    analysisStatus: r.analysisStatus as MessageSummary["analysisStatus"],
    taskIds: links.filter((l) => l.messageId === r.id).map((l) => l.taskId),
    folders: folders.filter((f) => f.messageId === r.id).map((f) => f.name),
    deleted: r.deletedAt !== null,
  }));
}

export async function listMessages(
  db: Executor,
  userId: string,
  q: { search?: string | undefined; accountId?: string | undefined; withoutTask?: "true" | "false" | undefined; limit: number; before?: string | undefined },
): Promise<MessageSummary[]> {
  const conditions = [eq(mailAccounts.userId, userId)];
  if (q.accountId) conditions.push(eq(messages.accountId, q.accountId));
  if (q.before) conditions.push(lt(messages.sentAt, new Date(q.before)));
  if (q.search) {
    const term = `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      or(ilike(messages.subject, term), ilike(messages.fromName, term), ilike(messages.fromAddress, term), ilike(messages.bodyText, term))!,
    );
  }
  if (q.withoutTask === "true") {
    conditions.push(
      notExists(db.select({ one: sql`1` }).from(taskSources).where(and(eq(taskSources.messageId, messages.id), isNull(taskSources.removedAt)))),
    );
  }
  const rows = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
    .where(and(...conditions))
    .orderBy(desc(messages.sentAt))
    .limit(q.limit);
  return summaries(
    db,
    rows.map((r) => r.message),
  );
}

/**
 * The safe view is always available. message:// is offered with an explicit caveat: Apple Mail
 * on macOS usually resolves it by Message-ID, iOS does not document it.
 */
export async function getMessageDetail(db: Executor, userId: string, messageId: string): Promise<MessageDetail> {
  const rows = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
    .where(and(eq(messages.id, messageId), eq(mailAccounts.userId, userId)))
    .limit(1);
  const m = rows[0]?.message;
  if (!m) throw notFound("Mail");
  const [summary] = await summaries(db, [m]);
  const marker = await db
    .select({ status: markerOperations.status })
    .from(markerOperations)
    .where(and(eq(markerOperations.messageId, m.id), eq(markerOperations.operation, "set")))
    .limit(1);
  const rfc = m.rfcMessageId?.replace(/^<|>$/g, "") ?? null;
  return {
    message: summary!,
    to: m.toAddresses,
    cc: m.ccAddresses,
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    remoteContentBlocked: m.remoteContentBlocked,
    attachments: m.attachments,
    open: {
      webLink: m.webLink,
      appleMailUrl: rfc ? `message://${encodeURIComponent(`<${rfc}>`)}` : null,
      appleMailNote: rfc
        ? "Öffnet die Mail in Apple Mail, wenn die Nachricht dort per Message-ID gefunden wird (macOS). Auf dem iPhone nicht zuverlässig – dann Suchangaben nutzen."
        : "Keine Message-ID vorhanden – bitte über die Suchangaben in Apple Mail suchen.",
      searchHints: {
        from: m.fromAddress,
        subject: m.subject,
        date: m.sentAt ? m.sentAt.toISOString().slice(0, 10) : null,
        messageIdHeader: rfc,
      },
    },
    markerStatus: (marker[0]?.status as MessageDetail["markerStatus"] | undefined) ?? (m.markerStatus as MessageDetail["markerStatus"]),
  };
}

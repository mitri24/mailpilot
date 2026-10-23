import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { schema, type Tx } from "@mailpilot/database";
import type { MailChange, NormalizedMessage } from "@mailpilot/mail-connectors";
import type { AccountRow } from "./deps.js";

const { messages, messageLocations, threads, mailFolders } = schema;

export interface IngestStats {
  fetched: number;
  newMessages: number;
  updatedMessages: number;
  skipped: number;
}

export interface IngestResult {
  stats: IngestStats;
  /** Messages whose content is new or changed and must be analyzed. */
  toAnalyze: string[];
  /** Own messages (sent mail) – used to make own replies visible on tasks of the thread. */
  ownMessages: string[];
}

type FolderRow = typeof mailFolders.$inferSelect;

const subjectKey = (subject: string | null) =>
  (subject ?? "")
    .replace(/^\s*((re|aw|wg|fw|fwd|tr|rv|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .trim()
    .toLowerCase() || null;

/**
 * Writes one fetch batch. The database stays the authority: identities are unique per account,
 * moves only change locations, and a deletion never removes tasks.
 */
export async function ingestChanges(
  tx: Tx,
  account: AccountRow,
  folders: FolderRow[],
  ownAddresses: Set<string>,
  changes: MailChange[],
): Promise<IngestResult> {
  const byProviderId = new Map(folders.map((f) => [f.providerFolderId, f]));
  const result: IngestResult = { stats: { fetched: 0, newMessages: 0, updatedMessages: 0, skipped: 0 }, toAnalyze: [], ownMessages: [] };

  for (const change of changes) {
    if (change.kind === "upsert") {
      result.stats.fetched++;
      await upsertMessage(tx, account, byProviderId, ownAddresses, change.message, result);
    } else if (change.kind === "location_removed") {
      const folder = byProviderId.get(change.location.providerFolderId);
      if (!folder) continue;
      const conditions = [eq(messageLocations.folderId, folder.id)];
      if (change.location.uid !== null) {
        conditions.push(eq(messageLocations.imapUid, change.location.uid));
        if (change.location.uidValidity !== null) conditions.push(eq(messageLocations.imapUidValidity, change.location.uidValidity));
      } else if (change.identityKey) {
        const [msg] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.accountId, account.id), eq(messages.identityKey, change.identityKey)));
        if (!msg) continue;
        conditions.push(eq(messageLocations.messageId, msg.id));
      } else continue;
      await tx.update(messageLocations).set({ present: false, removedAt: new Date() }).where(and(...conditions));
    } else {
      // Gone from the mailbox. The stored copy and every task linked to it stay.
      await tx
        .update(messages)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(messages.accountId, account.id), eq(messages.identityKey, change.identityKey), isNull(messages.deletedAt)));
      const [msg] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.accountId, account.id), eq(messages.identityKey, change.identityKey)));
      if (msg) await tx.update(messageLocations).set({ present: false, removedAt: new Date() }).where(eq(messageLocations.messageId, msg.id));
    }
  }
  return result;
}

async function upsertMessage(
  tx: Tx,
  account: AccountRow,
  byProviderId: Map<string, FolderRow>,
  ownAddresses: Set<string>,
  m: NormalizedMessage,
  result: IngestResult,
) {
  const isFromMe = m.from ? ownAddresses.has(m.from.address.toLowerCase()) : false;
  const [existing] = await tx.select().from(messages).where(and(eq(messages.accountId, account.id), eq(messages.identityKey, m.identityKey))).limit(1);
  const content = {
    providerMessageId: m.providerMessageId,
    rfcMessageId: m.rfcMessageId,
    inReplyTo: m.inReplyTo,
    referencesIds: m.references,
    fromAddress: m.from?.address ?? null,
    fromName: m.from?.name ?? null,
    toAddresses: m.to,
    ccAddresses: m.cc,
    subject: m.subject,
    sentAt: m.sentAt,
    receivedAt: m.receivedAt,
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtmlSanitized,
    remoteContentBlocked: m.remoteContentBlocked,
    snippet: m.snippet,
    hasAttachments: m.attachments.length > 0,
    attachments: m.attachments,
    sizeBytes: m.sizeBytes,
    contentHash: m.contentHash,
    headersFingerprint: m.headersFingerprint,
    webLink: m.webLink,
    isFromMe,
  };

  let messageId: string;
  if (!existing) {
    const threadId = await resolveThread(tx, account.id, m);
    const [row] = await tx
      .insert(messages)
      .values({
        accountId: account.id,
        identityKey: m.identityKey,
        threadId,
        ...content,
        // Own mails are context for replies, not a source of new tasks.
        analysisStatus: isFromMe ? "skipped" : "pending",
        analysisError: isFromMe ? "Eigene Mail – nur als Gesprächskontext verwendet" : null,
      })
      .onConflictDoNothing({ target: [messages.accountId, messages.identityKey] })
      .returning({ id: messages.id });
    if (!row) return; // inserted concurrently; the next scan sees it
    messageId = row.id;
    result.stats.newMessages++;
    if (isFromMe) {
      result.stats.skipped++;
      result.ownMessages.push(messageId);
    } else result.toAnalyze.push(messageId);
  } else {
    messageId = existing.id;
    const changed = existing.contentHash !== m.contentHash;
    await tx
      .update(messages)
      .set({
        ...(changed ? content : { webLink: m.webLink ?? existing.webLink, providerMessageId: m.providerMessageId ?? existing.providerMessageId }),
        deletedAt: null,
        ...(changed && !isFromMe && existing.analysisContentHash !== m.contentHash ? { analysisStatus: "pending", analysisAttempts: 0, analysisError: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(messages.id, existing.id));
    if (changed) {
      result.stats.updatedMessages++;
      if (!isFromMe && existing.analysisContentHash !== m.contentHash) result.toAnalyze.push(messageId);
    }
  }

  if (m.location) {
    const folder = byProviderId.get(m.location.providerFolderId);
    if (folder) {
      // A reused (folder, UIDVALIDITY, UID) slot belongs to the new message.
      if (m.location.uid !== null) {
        await tx
          .delete(messageLocations)
          .where(
            and(
              eq(messageLocations.folderId, folder.id),
              eq(messageLocations.imapUid, m.location.uid),
              m.location.uidValidity !== null ? eq(messageLocations.imapUidValidity, m.location.uidValidity) : isNull(messageLocations.imapUidValidity),
              sql`${messageLocations.messageId} <> ${messageId}`,
            ),
          );
      }
      await tx
        .insert(messageLocations)
        .values({
          messageId,
          folderId: folder.id,
          imapUidValidity: m.location.uidValidity,
          imapUid: m.location.uid,
          flags: m.location.flags,
          present: true,
        })
        .onConflictDoUpdate({
          target: [messageLocations.messageId, messageLocations.folderId],
          set: {
            imapUidValidity: m.location.uidValidity,
            imapUid: m.location.uid,
            flags: m.location.flags,
            present: true,
            removedAt: null,
            lastSeenAt: new Date(),
          },
        });
    }
  }
}

/**
 * Thread membership: provider thread ids where available (Gmail, Graph), otherwise the
 * In-Reply-To/References chain. Belonging to a thread is context, never proof of the same task.
 */
async function resolveThread(tx: Tx, accountId: string, m: NormalizedMessage): Promise<string> {
  if (m.providerThreadId) {
    const [row] = await tx
      .insert(threads)
      .values({ accountId, providerThreadId: m.providerThreadId, subjectKey: subjectKey(m.subject) })
      .onConflictDoUpdate({ target: [threads.accountId, threads.providerThreadId], set: { updatedAt: new Date() } })
      .returning({ id: threads.id });
    return row!.id;
  }
  const refs = [m.inReplyTo, ...m.references].filter((r): r is string => Boolean(r));
  if (refs.length > 0) {
    const [parent] = await tx
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), inArray(messages.rfcMessageId, refs), isNotNull(messages.threadId)))
      .limit(1);
    if (parent?.threadId) return parent.threadId;
  }
  if (m.rfcMessageId) {
    // A reply may have arrived before its parent.
    const [child] = await tx
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          isNotNull(messages.threadId),
          or(eq(messages.inReplyTo, m.rfcMessageId), sql`${m.rfcMessageId} = any(${messages.referencesIds})`),
        ),
      )
      .limit(1);
    if (child?.threadId) return child.threadId;
  }
  const [row] = await tx.insert(threads).values({ accountId, providerThreadId: null, subjectKey: subjectKey(m.subject) }).returning({ id: threads.id });
  return row!.id;
}

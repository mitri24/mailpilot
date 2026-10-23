import { and, eq, sql } from "drizzle-orm";
import type { ApplyMarkerPayload, MarkerStrategy } from "@mailpilot/contracts";
import { recordChange, schema, userTransaction } from "@mailpilot/database";
import { ConnectorError, type MailConnector } from "@mailpilot/mail-connectors";
import type { WorkerDeps } from "./deps.js";

const { markerOperations, mailAccounts, messages, messageLocations, mailFolders } = schema;

export const MAX_MARKER_ATTEMPTS = 5;

/**
 * Sets the configured marker on the original mail. Runs after the task is committed (outbox);
 * a failure is recorded on the marker only and never touches tasks.
 */
export async function applyMarker(deps: WorkerDeps, payload: ApplyMarkerPayload): Promise<void> {
  const { db } = deps;
  const [op] = await db.select().from(markerOperations).where(eq(markerOperations.id, payload.markerOperationId)).limit(1);
  if (!op || op.status === "applied" || op.status === "unsupported" || op.status === "cancelled") return;
  const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, op.accountId)).limit(1);
  const [message] = await db.select().from(messages).where(eq(messages.id, op.messageId)).limit(1);
  const finish = async (status: string, markerStatus: string, lastError: string | null = null) => {
    await db.update(markerOperations).set({ status, lastError, updatedAt: new Date() }).where(eq(markerOperations.id, op.id));
    await db.update(messages).set({ markerStatus }).where(eq(messages.id, op.messageId));
  };
  if (!account || account.removedAt || !message) return finish("cancelled", "not_requested", "Konto oder Mail nicht mehr vorhanden");
  if (account.markerStrategy !== op.strategy || !account.markerAcknowledged) {
    return finish("cancelled", "not_requested", "Markierung wurde in den Einstellungen geändert");
  }
  if (account.status === "paused") return; // picked up again by the safety net after resuming

  const [location] = await db
    .select({ loc: messageLocations, folder: mailFolders })
    .from(messageLocations)
    .innerJoin(mailFolders, eq(mailFolders.id, messageLocations.folderId))
    .where(and(eq(messageLocations.messageId, message.id), eq(messageLocations.present, true)))
    .orderBy(sql`case when ${mailFolders.role} = 'inbox' then 0 else 1 end`)
    .limit(1);

  let connector: MailConnector | null = null;
  try {
    connector = await deps.connectorFor(account);
    const result = await connector.applyMarker(
      {
        strategy: op.strategy as MarkerStrategy,
        keyword: account.markerKeyword,
        folder: account.markerFolder,
        message: {
          providerMessageId: message.providerMessageId,
          rfcMessageId: message.rfcMessageId,
          location: location
            ? { providerFolderId: location.folder.providerFolderId, uidValidity: location.loc.imapUidValidity, uid: location.loc.imapUid, flags: location.loc.flags }
            : null,
        },
      },
      "set",
    );
    if (result.status === "applied") return finish("applied", "applied");
    if (result.status === "unsupported") return finish("unsupported", "unsupported", result.detail);
    throw new Error(result.detail ?? "Markierung fehlgeschlagen");
  } catch (error) {
    const attempts = op.attempts + 1;
    const detail = error instanceof ConnectorError ? `${error.message} – ${error.userAction}` : error instanceof Error ? error.message : String(error);
    if (attempts >= MAX_MARKER_ATTEMPTS) {
      await userTransaction(db, account.userId, async (tx) => {
        await tx.update(markerOperations).set({ status: "failed", attempts, lastError: detail, updatedAt: new Date() }).where(eq(markerOperations.id, op.id));
        await tx.update(messages).set({ markerStatus: "failed" }).where(eq(messages.id, op.messageId));
        // The account shows the number of failed markers.
        const [acc] = await tx
          .update(mailAccounts)
          .set({ version: sql`${mailAccounts.version} + 1` })
          .where(eq(mailAccounts.id, account.id))
          .returning({ version: mailAccounts.version });
        await recordChange(tx, { userId: account.userId, entityType: "account", entityId: account.id, op: "upsert", version: acc!.version });
      });
      deps.log.warn({ markerOperationId: op.id }, "marker failed permanently");
      return;
    }
    await db.update(markerOperations).set({ attempts, lastError: detail, updatedAt: new Date() }).where(eq(markerOperations.id, op.id));
    throw error; // retried with backoff by the job queue
  } finally {
    await connector?.close().catch(() => undefined);
  }
}

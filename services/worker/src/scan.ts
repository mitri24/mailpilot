import { and, eq, isNull } from "drizzle-orm";
import { Jobs, type ScanAccountPayload } from "@mailpilot/contracts";
import { recordChange, schema, userTransaction, type Executor } from "@mailpilot/database";
import { ConnectorError, type FetchFolder, type MailConnector } from "@mailpilot/mail-connectors";
import type { AccountRow, WorkerDeps } from "./deps.js";
import { ingestChanges } from "./ingest.js";
import { noteOwnReplies } from "./apply.js";
import { bumpRunStats, finishRun, startRun } from "./runs.js";

const { mailAccounts, mailFolders, syncCursors, processingRuns, users } = schema;

export const analyzeQueue = (userId: string) => `analyze:${userId}`;

export async function enqueueAnalysis(deps: WorkerDeps, userId: string, messageIds: string[], runId: string | null): Promise<void> {
  for (const messageId of messageIds) {
    await deps.enqueue(
      Jobs.analyzeMessage,
      { messageId, runId, force: false },
      // One analysis per message at a time; per user in sequence so the budget check holds.
      { jobKey: `analyze:${messageId}`, queueName: analyzeQueue(userId), maxAttempts: deps.limits.maxAnalysisAttempts },
    );
  }
}

/** All addresses that count as "me" for this user: every connected account plus its aliases. */
export async function ownAddressesOf(db: Executor, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ email: mailAccounts.emailAddress, aliases: mailAccounts.aliases })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.userId, userId), isNull(mailAccounts.removedAt)));
  return new Set(rows.flatMap((r) => [r.email, ...r.aliases]).map((a) => a.toLowerCase()));
}

async function setAccountError(deps: WorkerDeps, account: AccountRow, error: ConnectorError | Error): Promise<void> {
  const ce = error instanceof ConnectorError ? error : null;
  const needsReauth = ce?.code === "auth_failed" || ce?.code === "needs_reauth";
  await userTransaction(deps.db, account.userId, async (tx) => {
    const [row] = await tx.select({ version: mailAccounts.version, status: mailAccounts.status }).from(mailAccounts).where(eq(mailAccounts.id, account.id)).for("update");
    if (!row) return;
    const version = row.version + 1;
    await tx
      .update(mailAccounts)
      .set({
        status: row.status === "paused" ? "paused" : needsReauth ? "needs_reauth" : "error",
        lastErrorCode: ce?.code ?? "unknown",
        lastErrorMessage: ce?.message ?? "Mailabruf fehlgeschlagen",
        lastErrorAction: ce?.userAction ?? "Verbindung prüfen",
        lastErrorAt: deps.now(),
        version,
        updatedAt: deps.now(),
      })
      .where(eq(mailAccounts.id, account.id));
    await recordChange(tx, { userId: account.userId, entityType: "account", entityId: account.id, op: "upsert", version });
  });
}

async function markFetchSuccess(deps: WorkerDeps, account: AccountRow): Promise<void> {
  await userTransaction(deps.db, account.userId, async (tx) => {
    const [row] = await tx.select().from(mailAccounts).where(eq(mailAccounts.id, account.id)).for("update");
    if (!row) return;
    const version = row.version + 1;
    await tx
      .update(mailAccounts)
      .set({
        status: row.status === "error" ? "active" : row.status,
        lastSuccessfulFetchAt: deps.now(),
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAction: null,
        lastErrorAt: null,
        version,
        updatedAt: deps.now(),
      })
      .where(eq(mailAccounts.id, account.id));
    await recordChange(tx, { userId: account.userId, entityType: "account", entityId: account.id, op: "upsert", version });
  });
}

/** Refreshes the folder list; new folders stay unselected except a new inbox or sent folder. */
async function syncFolders(deps: WorkerDeps, account: AccountRow, connector: MailConnector) {
  const remote = await connector.listFolders();
  for (const f of remote) {
    await deps.db
      .insert(mailFolders)
      .values({
        accountId: account.id,
        providerFolderId: f.providerFolderId,
        path: f.path,
        name: f.name,
        role: f.role,
        selected: f.role === "inbox" || (account.includeSent && f.role === "sent"),
        imapUidValidity: f.uidValidity,
      })
      .onConflictDoUpdate({ target: [mailFolders.accountId, mailFolders.providerFolderId], set: { path: f.path, name: f.name, role: f.role, updatedAt: new Date() } });
  }
  return deps.db.select().from(mailFolders).where(eq(mailFolders.accountId, account.id));
}

export async function scanAccount(deps: WorkerDeps, payload: ScanAccountPayload): Promise<void> {
  const { db } = deps;
  const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, payload.accountId)).limit(1);
  const [run] = await db.select().from(processingRuns).where(eq(processingRuns.id, payload.runId)).limit(1);
  if (!run) return;
  if (!account || account.removedAt) return finishRun(db, run.id, "failed", "Konto wurde entfernt");
  if (account.status === "paused") return finishRun(db, run.id, "failed", "Konto ist pausiert");
  if (account.status === "needs_reauth") return finishRun(db, run.id, "failed", account.lastErrorMessage ?? "Konto muss erneut verbunden werden");

  await startRun(db, run.id);
  const [user] = await db.select().from(users).where(eq(users.id, account.userId)).limit(1);
  let connector: MailConnector | null = null;
  try {
    connector = await deps.connectorFor(account);
    const folders = await syncFolders(deps, account, connector);
    const selected = folders.filter((f) => f.selected);
    if (selected.length === 0) {
      await finishRun(db, run.id, "failed", "Keine Ordner zur Synchronisierung ausgewählt");
      return;
    }
    const fetchFolders: FetchFolder[] = selected.map((f) => ({ providerFolderId: f.providerFolderId, role: f.role as FetchFolder["role"], uidValidity: f.imapUidValidity }));
    const ownAddresses = await ownAddressesOf(db, account.userId);
    const since = new Date(deps.now().getTime() - account.initialImportDays * 86_400_000);
    const resets: string[] = [];

    let complete = false;
    for (let round = 0; round < deps.limits.maxFetchRounds && !complete; round++) {
      const stored = await db.select().from(syncCursors).where(eq(syncCursors.accountId, account.id));
      const cursors = Object.fromEntries(stored.map((c) => [c.kind, c.cursor]));
      const fetched = await connector.fetchChanges({
        folders: fetchFolders,
        cursors,
        since,
        maxMessages: deps.limits.maxMessagesPerFetch,
        maxMessageBytes: deps.limits.maxMessageBytes,
        ownAddresses: [...ownAddresses],
      });
      complete = fetched.complete;
      for (const r of fetched.cursorResets) resets.push(`${r.providerFolderId}: ${r.reason}`);

      // Data and cursors commit together: a crash re-fetches instead of skipping mail.
      const ingested = await userTransaction(db, account.userId, async (tx) => {
        const out = await ingestChanges(tx, account, folders, ownAddresses, fetched.changes);
        for (const [kind, cursor] of Object.entries(fetched.cursors)) {
          // Account-level cursors (folder_id null); the per-user lock rules out a concurrent insert.
          const updated = await tx
            .update(syncCursors)
            .set({ cursor, updatedAt: new Date() })
            .where(and(eq(syncCursors.accountId, account.id), eq(syncCursors.kind, kind), isNull(syncCursors.folderId)))
            .returning({ id: syncCursors.id });
          if (updated.length === 0) await tx.insert(syncCursors).values({ accountId: account.id, folderId: null, kind, cursor });
        }
        for (const [providerFolderId, uidValidity] of Object.entries(fetched.uidValidity)) {
          await tx
            .update(mailFolders)
            .set({ imapUidValidity: uidValidity, updatedAt: new Date() })
            .where(and(eq(mailFolders.accountId, account.id), eq(mailFolders.providerFolderId, providerFolderId)));
        }
        await bumpRunStats(tx, run.id, out.stats);
        if (out.ownMessages.length > 0) await noteOwnReplies(tx, account.userId, out.ownMessages, user?.timezone ?? "Europe/Paris");
        return out;
      });
      await enqueueAnalysis(deps, account.userId, ingested.toAnalyze, run.id);
    }

    await markFetchSuccess(deps, account);
    if (!complete) {
      // More mail than one run may fetch: continue in a follow-up run instead of blocking the queue.
      const [next] = await db.insert(processingRuns).values({ userId: account.userId, accountId: account.id, kind: "scan", trigger: "retry", status: "queued" }).returning();
      await deps.enqueue(Jobs.scanAccount, { accountId: account.id, trigger: "retry", runId: next!.id }, { jobKey: `scan:${account.id}` });
    }
    await finishRun(db, run.id, resets.length > 0 ? "partial" : "succeeded", resets.length > 0 ? `Neu eingelesen: ${resets.join("; ")}` : null);
    deps.log.info({ accountId: account.id, runId: run.id, user: user?.id }, "scan finished");
  } catch (error) {
    deps.log.warn({ accountId: account.id, runId: run.id, code: error instanceof ConnectorError ? error.code : "unknown" }, "scan failed");
    await setAccountError(deps, account, error instanceof Error ? error : new Error(String(error)));
    await bumpRunStats(db, run.id, { errors: 1 });
    await finishRun(db, run.id, "failed", error instanceof ConnectorError ? `${error.message} – ${error.userAction}` : "Mailabruf fehlgeschlagen");
    if (error instanceof ConnectorError && error.code === "rate_limited") {
      const [retry] = await db.insert(processingRuns).values({ userId: account.userId, accountId: account.id, kind: "scan", trigger: "retry", status: "queued" }).returning();
      await deps.enqueue(
        Jobs.scanAccount,
        { accountId: account.id, trigger: "retry", runId: retry!.id },
        { jobKey: `scan:${account.id}`, runAt: new Date(deps.now().getTime() + (error.retryAfterSeconds ?? 300) * 1000) },
      );
    }
  } finally {
    await connector?.close().catch(() => undefined);
  }
}


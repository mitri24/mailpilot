import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { FixtureAnalyzer, type FixtureResolver, type WireOutput } from "@mailpilot/ai";
import type { AccountCapabilities, JobName } from "@mailpilot/contracts";
import { createDb, schema, type DbHandle } from "@mailpilot/database";
import type { MailConnector } from "@mailpilot/mail-connectors";
import type { AccountRow, EnqueueOptions, Notifier, PushMessage, WorkerDeps } from "../src/deps.js";
import { taskList } from "../src/jobs.js";
import { FakeMailbox } from "./fake-mailbox.js";
import { testDatabaseUrl } from "./global-setup.js";

export const imapCaps = (over: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
  incrementalSync: "imap_uid",
  customKeywords: true,
  flagged: true,
  labels: false,
  categories: false,
  copyToFolder: true,
  webLinks: false,
  immutableIds: false,
  supportedMarkers: ["none", "imap_keyword", "imap_flagged", "imap_copy_folder"],
  notes: [],
  ...over,
});

export class RecordingNotifier implements Notifier {
  readonly sent: Array<{ userId: string; message: PushMessage }> = [];
  async send(userId: string, message: PushMessage) {
    this.sent.push({ userId, message });
    return { status: "sent" as const, detail: null };
  }
}

interface QueuedJob {
  name: JobName;
  payload: object;
  options: EnqueueOptions;
  attempts: number;
}

export interface Harness {
  handle: DbHandle;
  deps: WorkerDeps;
  analyzer: FixtureAnalyzer;
  fixtures: Map<string, WireOutput>;
  notifier: RecordingNotifier;
  queue: QueuedJob[];
  mailboxes: Map<string, FakeMailbox>;
  clock: { now: Date };
  /** Runs queued jobs like the job queue would: in order, jobKey-deduplicated, failed jobs retried up to maxAttempts. */
  drain: () => Promise<{ ran: number; failed: Array<{ name: string; error: string }> }>;
  createUser: (over?: Partial<typeof schema.users.$inferInsert>) => Promise<typeof schema.users.$inferSelect>;
  createAccount: (userId: string, mailbox: FakeMailbox, over?: Partial<typeof schema.mailAccounts.$inferInsert>) => Promise<AccountRow>;
  close: () => Promise<void>;
}

export async function createHarness(options: { analyzer?: "fixture" | "off" } = {}): Promise<Harness> {
  const handle = createDb(testDatabaseUrl(), { max: 5 });
  const fixtures = new Map<string, WireOutput>();
  const resolver: FixtureResolver = (input) => fixtures.get(input.message.subject ?? "") ?? null;
  const analyzer = new FixtureAnalyzer(resolver);
  const notifier = new RecordingNotifier();
  const queue: QueuedJob[] = [];
  const mailboxes = new Map<string, FakeMailbox>();
  const clock = { now: new Date() };

  const deps: WorkerDeps = {
    db: handle.db,
    enqueue: async (name, payload, opts = {}) => {
      if (opts.jobKey) {
        const existing = queue.findIndex((j) => j.options.jobKey === opts.jobKey);
        if (existing >= 0) queue.splice(existing, 1);
      }
      queue.push({ name, payload, options: opts, attempts: 0 });
    },
    connectorFor: async (account: AccountRow): Promise<MailConnector> => {
      const box = mailboxes.get(account.id);
      if (!box) throw new Error(`no mailbox for ${account.id}`);
      return box.connector();
    },
    analyzer: options.analyzer === "off" ? null : analyzer,
    analyzerDisabledReason: options.analyzer === "off" ? "KI-Analyse ist nicht eingerichtet (AI_PROVIDER)" : null,
    prices: options.analyzer === "off" ? null : { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
    expectedOutputTokens: 1000,
    notifier,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => clock.now,
    limits: { maxMessagesPerFetch: 100, maxMessageBytes: 5_000_000, maxFetchRounds: 3, maxAnalysisAttempts: 3 },
  };
  const tasks = taskList(deps);

  const drain = async () => {
    let ran = 0;
    const failed: Array<{ name: string; error: string }> = [];
    for (let guard = 0; queue.length > 0 && guard < 500; guard++) {
      const job = queue.shift()!;
      job.attempts++;
      try {
        await tasks[job.name]!(job.payload as never, {} as never);
        ran++;
      } catch (error) {
        if (job.attempts < (job.options.maxAttempts ?? 25)) queue.push(job);
        else failed.push({ name: job.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ran, failed };
  };

  return {
    handle,
    deps,
    analyzer,
    fixtures,
    notifier,
    queue,
    mailboxes,
    clock,
    drain,
    createUser: async (over = {}) => {
      const [u] = await handle.db
        .insert(schema.users)
        .values({ devEmail: `w-${randomUUID()}@example.test`, timezone: "Europe/Paris", ...over })
        .returning();
      return u!;
    },
    createAccount: async (userId, mailbox, over = {}) => {
      const [a] = await handle.db
        .insert(schema.mailAccounts)
        .values({
          userId,
          provider: "imap",
          displayName: "Konto",
          emailAddress: `ich-${randomUUID().slice(0, 6)}@example.test`,
          capabilities: mailbox.capabilities,
          ...over,
        })
        .returning();
      mailboxes.set(a!.id, mailbox);
      return a!;
    },
    close: () => handle.close(),
  };
}

/** Selects INBOX and Sent the way account setup does. */
export async function selectDefaultFolders(h: Harness, account: AccountRow) {
  const box = h.mailboxes.get(account.id)!;
  for (const folders of [await box.connector().listFolders()]) {
    for (const f of folders) {
      await h.handle.db
        .insert(schema.mailFolders)
        .values({ accountId: account.id, providerFolderId: f.providerFolderId, path: f.path, name: f.name, role: f.role, selected: f.role === "inbox" || f.role === "sent", imapUidValidity: f.uidValidity })
        .onConflictDoNothing();
    }
  }
}

export async function runScan(h: Harness, userId: string, accountId: string) {
  const [run] = await h.handle.db.insert(schema.processingRuns).values({ userId, accountId, kind: "scan", trigger: "manual", status: "queued" }).returning();
  await h.deps.enqueue("scan_account", { accountId, trigger: "manual", runId: run!.id }, { jobKey: `scan:${accountId}` });
  const result = await h.drain();
  const [after] = await h.handle.db.select().from(schema.processingRuns).where(eq(schema.processingRuns.id, run!.id));
  return { run: after!, ...result };
}

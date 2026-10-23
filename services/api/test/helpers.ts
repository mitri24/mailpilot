import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AccountCapabilities } from "@mailpilot/contracts";
import { createDb, schema, type DbHandle } from "@mailpilot/database";
import type { AppleTokenVerifier } from "../src/auth/apple.js";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { RecordingQueue } from "../src/queue.js";
import type { AccountServices } from "../src/routes/accounts.js";
import { testDatabaseUrl } from "./env.js";

export interface TestContext {
  app: FastifyInstance;
  handle: DbHandle;
  queue: RecordingQueue;
  config: Config;
  close: () => Promise<void>;
}

export async function createTestContext(
  options: { accounts?: Partial<AccountServices>; devLogin?: boolean; apple?: AppleTokenVerifier } = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseUrl(),
    CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    DEV_LOGIN_ENABLED: options.devLogin === false ? "false" : "true",
    PUBLIC_BASE_URL: "http://localhost:8787",
  });
  const handle = createDb(config.DATABASE_URL, { max: 5 });
  const queue = new RecordingQueue();
  const app = await buildApp({ config, db: handle.db, queue, accounts: options.accounts ?? {}, ...(options.apple ? { apple: options.apple } : {}) });
  await app.ready();
  return {
    app,
    handle,
    queue,
    config,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

export interface Session {
  token: string;
  userId: string;
  headers: Record<string, string>;
}

export async function login(app: FastifyInstance, email = `user-${randomUUID()}@example.test`): Promise<Session> {
  const res = await app.inject({ method: "POST", url: "/v1/auth/dev", payload: { email } });
  if (res.statusCode !== 200) throw new Error(`dev login failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id, headers: { authorization: `Bearer ${body.token}` } };
}

export const imapCapabilities = (overrides: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
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
  ...overrides,
});

export async function seedAccount(handle: DbHandle, userId: string, overrides: Partial<typeof schema.mailAccounts.$inferInsert> = {}) {
  const [row] = await handle.db
    .insert(schema.mailAccounts)
    .values({
      userId,
      provider: "imap",
      displayName: "Testpostfach",
      emailAddress: `box-${randomUUID().slice(0, 8)}@example.test`,
      capabilities: imapCapabilities(),
      ...overrides,
    })
    .returning();
  return row!;
}

export async function seedMessage(
  handle: DbHandle,
  accountId: string,
  overrides: Partial<typeof schema.messages.$inferInsert> = {},
) {
  const body = overrides.bodyText ?? "Bitte sende mir bis Freitag die Unterlagen.";
  const [row] = await handle.db
    .insert(schema.messages)
    .values({
      accountId,
      identityKey: `rfc:<${randomUUID()}@example.test>`,
      subject: "Unterlagen",
      fromAddress: "absender@example.test",
      fromName: "Absender",
      sentAt: new Date(),
      receivedAt: new Date(),
      bodyText: body,
      contentHash: createHash("sha256").update(body).digest("hex"),
      ...overrides,
    })
    .returning();
  return row!;
}

export async function seedClarification(
  handle: DbHandle,
  userId: string,
  overrides: Partial<typeof schema.clarificationRequests.$inferInsert> = {},
) {
  const [row] = await handle.db
    .insert(schema.clarificationRequests)
    .values({
      userId,
      kind: "membership",
      question: "Gehörst du zur Gruppe B2?",
      reason: "Die Mail richtet sich an die Gruppe B2.",
      subject: "B2",
      options: [
        { id: "yes", label: "Ja", scope: "permanent" },
        { id: "no", label: "Nein", scope: "permanent" },
        { id: "not_this_time", label: "Diesmal nicht", scope: "once" },
      ],
      allowFreeText: false,
      dedupeKey: `membership:b2:${randomUUID()}`,
      ...overrides,
    })
    .returning();
  return row!;
}

export const uuid = () => randomUUID();

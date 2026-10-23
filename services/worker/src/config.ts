import { z } from "zod";

const WorkerEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(40),
  /** Same value as for the API; part of the registered OAuth client configuration. */
  PUBLIC_BASE_URL: z.url().default("http://localhost:8787"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  MAX_MESSAGES_PER_FETCH: z.coerce.number().int().min(10).max(2000).default(200),
  MAX_MESSAGE_BYTES: z.coerce.number().int().min(100_000).max(50_000_000).default(10_000_000),
  MAX_FETCH_ROUNDS: z.coerce.number().int().min(1).max(100).default(10),
  MAX_ANALYSIS_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default("common"),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_PRIVATE_KEY_FILE: z.string().optional(),
  APNS_TOPIC: z.string().optional(),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  /** Local GreenMail only: accept its self-signed certificate for 127.0.0.1/localhost. Never in production. */
  DEV_IMAP_ALLOW_SELF_SIGNED_LOCALHOST: z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1").default(false),
});

export type WorkerConfig = z.infer<typeof WorkerEnv> & {
  apns: { keyId: string; teamId: string; privateKeyPath: string; topic: string } | null;
};

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // An empty value in .env counts as not set.
  env = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = WorkerEnv.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration:\n${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const c = parsed.data;
  if (c.DEV_IMAP_ALLOW_SELF_SIGNED_LOCALHOST && c.NODE_ENV === "production") {
    throw new Error("DEV_IMAP_ALLOW_SELF_SIGNED_LOCALHOST must not be set in production");
  }
  const apns =
    c.APNS_KEY_ID && c.APNS_TEAM_ID && c.APNS_PRIVATE_KEY_FILE && c.APNS_TOPIC
      ? { keyId: c.APNS_KEY_ID, teamId: c.APNS_TEAM_ID, privateKeyPath: c.APNS_PRIVATE_KEY_FILE, topic: c.APNS_TOPIC }
      : null;
  return { ...c, apns };
}

import { z } from "zod";

const Bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(8787),
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.url().default("http://localhost:8787"),
  APP_URL_SCHEME: z.string().regex(/^[a-z][a-z0-9+.-]*$/).default("mailpilot"),
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(40),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  DEV_LOGIN_ENABLED: Bool.default(false),
  /** Local GreenMail only: accept its self-signed certificate for 127.0.0.1/localhost. Never in production. */
  DEV_IMAP_ALLOW_SELF_SIGNED_LOCALHOST: Bool.default(false),
  /** Comma-separated bundle ids / service ids accepted as `aud` of Apple identity tokens. */
  APPLE_AUDIENCES: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default("common"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema> & {
  appleAudiences: string[];
  devLoginAllowed: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value in .env counts as not set.
  env = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  if (c.DEV_LOGIN_ENABLED && c.NODE_ENV === "production") {
    throw new Error("DEV_LOGIN_ENABLED must not be set in production");
  }
  if (c.DEV_IMAP_ALLOW_SELF_SIGNED_LOCALHOST && c.NODE_ENV === "production") {
    throw new Error("DEV_IMAP_ALLOW_SELF_SIGNED_LOCALHOST must not be set in production");
  }
  return {
    ...c,
    appleAudiences: c.APPLE_AUDIENCES.split(",").map((s) => s.trim()).filter(Boolean),
    // The development login exists only when explicitly enabled outside production.
    devLoginAllowed: c.DEV_LOGIN_ENABLED && c.NODE_ENV !== "production",
  };
}

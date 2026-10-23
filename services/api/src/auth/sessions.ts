import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { sessions, users, type Database } from "@mailpilot/database";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface AuthContext {
  userId: string;
  sessionId: string;
  devLogin: boolean;
}

export async function createSession(
  db: Database,
  input: { userId: string; ttlDays: number; deviceName?: string | undefined; platform?: string | undefined; devLogin: boolean },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.ttlDays * 86_400_000);
  await db.insert(sessions).values({
    userId: input.userId,
    tokenHash: hashToken(token),
    deviceName: input.deviceName ?? null,
    platform: input.platform ?? null,
    devLogin: input.devLogin,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function resolveSession(db: Database, token: string): Promise<AuthContext | null> {
  const rows = await db
    .select({ id: sessions.id, userId: sessions.userId, devLogin: sessions.devLogin, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Touch at most once per hour to avoid a write per request.
  if (Date.now() - row.lastSeenAt.getTime() > 3_600_000) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.id));
  }
  return { userId: row.userId, sessionId: row.id, devLogin: row.devLogin };
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function findOrCreateUser(
  db: Database,
  by: { appleSub: string; email: string | null; displayName: string | null } | { devEmail: string },
): Promise<typeof users.$inferSelect> {
  if ("appleSub" in by) {
    const existing = await db.select().from(users).where(eq(users.appleSub, by.appleSub)).limit(1);
    if (existing[0]) {
      if (by.email && !existing[0].email) {
        await db.update(users).set({ email: by.email, updatedAt: new Date() }).where(eq(users.id, existing[0].id));
      }
      return existing[0];
    }
    const [created] = await db
      .insert(users)
      .values({ appleSub: by.appleSub, email: by.email, displayName: by.displayName })
      .onConflictDoNothing({ target: users.appleSub })
      .returning();
    if (created) return created;
    const again = await db.select().from(users).where(eq(users.appleSub, by.appleSub)).limit(1);
    return again[0]!;
  }
  const existing = await db.select().from(users).where(eq(users.devEmail, by.devEmail)).limit(1);
  if (existing[0]) return existing[0];
  const [created] = await db
    .insert(users)
    .values({ devEmail: by.devEmail, email: by.devEmail, displayName: by.devEmail.split("@")[0] ?? null })
    .onConflictDoNothing({ target: users.devEmail })
    .returning();
  if (created) return created;
  const again = await db.select().from(users).where(eq(users.devEmail, by.devEmail)).limit(1);
  return again[0]!;
}

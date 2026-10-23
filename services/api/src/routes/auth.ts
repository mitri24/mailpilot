import { eq } from "drizzle-orm";
import { z } from "zod";
import { AppleSignIn, DevSignIn, ErrorBody, Me, SessionResponse } from "@mailpilot/contracts";
import { schema, type Database } from "@mailpilot/database";
import type { AppleTokenVerifier } from "../auth/apple.js";
import { createSession, findOrCreateUser, revokeSession } from "../auth/sessions.js";
import type { Config } from "../config.js";
import { ApiError, notFound } from "../errors.js";
import { authOf, type Router } from "./types.js";

export function registerAuthRoutes(r: Router, deps: { config: Config; db: Database; apple: AppleTokenVerifier }) {
  const { config, db, apple } = deps;
  const meOf = (user: typeof schema.users.$inferSelect, devLogin: boolean) => ({
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    devLogin,
    createdAt: user.createdAt.toISOString(),
  });

  r.post(
    "/v1/auth/apple",
    {
      schema: {
        tags: ["auth"],
        summary: "Mit Apple anmelden (Identity Token wird serverseitig geprüft)",
        security: [],
        body: AppleSignIn,
        response: { 200: SessionResponse, 401: ErrorBody, 503: ErrorBody },
      },
    },
    async (request) => {
      const identity = await apple.verify(request.body.identityToken, request.body.nonce);
      const user = await findOrCreateUser(db, {
        appleSub: identity.sub,
        email: identity.email,
        displayName: request.body.fullName ?? null,
      });
      const session = await createSession(db, {
        userId: user.id,
        ttlDays: config.SESSION_TTL_DAYS,
        deviceName: request.body.deviceName,
        platform: request.body.platform,
        devLogin: false,
      });
      return { token: session.token, expiresAt: session.expiresAt.toISOString(), user: meOf(user, false) };
    },
  );

  r.post(
    "/v1/auth/dev",
    {
      schema: {
        tags: ["auth"],
        summary: "Entwicklungslogin – nur mit DEV_LOGIN_ENABLED außerhalb von Produktion",
        security: [],
        body: DevSignIn,
        response: { 200: SessionResponse, 404: ErrorBody },
      },
    },
    async (request) => {
      if (!config.devLoginAllowed) throw new ApiError(404, "not_found", "Nicht verfügbar");
      const user = await findOrCreateUser(db, { devEmail: request.body.email.toLowerCase() });
      const session = await createSession(db, {
        userId: user.id,
        ttlDays: 30,
        deviceName: request.body.deviceName,
        platform: request.body.platform,
        devLogin: true,
      });
      return { token: session.token, expiresAt: session.expiresAt.toISOString(), user: meOf(user, true) };
    },
  );

  r.post(
    "/v1/me/logout",
    { schema: { tags: ["auth"], summary: "Sitzung beenden", response: { 200: z.object({ ok: z.boolean() }) } } },
    async (request) => {
      await revokeSession(db, authOf(request).sessionId);
      return { ok: true };
    },
  );

  r.get("/v1/me", { schema: { tags: ["auth"], summary: "Angemeldeter Benutzer", response: { 200: Me } } }, async (request) => {
    const auth = authOf(request);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, auth.userId)).limit(1);
    if (!user) throw notFound("Benutzer");
    return meOf(user, auth.devLogin);
  });
}

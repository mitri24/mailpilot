import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AppleTokenVerifier } from "../src/auth/apple.js";
import { createTestContext, login, type TestContext } from "./helpers.js";

describe("auth", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());

  it("dev login issues a session that /v1/me accepts", async () => {
    const s = await login(ctx.app, "Dev@Example.test");
    const me = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: s.headers });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: s.userId, devLogin: true });
    // Same address, any casing: same user.
    const again = await login(ctx.app, "dev@example.test");
    expect(again.userId).toBe(s.userId);
  });

  it("rejects missing and unknown tokens", async () => {
    const none = await ctx.app.inject({ method: "GET", url: "/v1/tasks" });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe("unauthorized");
    const bad = await ctx.app.inject({ method: "GET", url: "/v1/tasks", headers: { authorization: "Bearer nope" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("session_invalid");
  });

  it("logout revokes the session", async () => {
    const s = await login(ctx.app);
    const out = await ctx.app.inject({ method: "POST", url: "/v1/me/logout", headers: s.headers });
    expect(out.statusCode).toBe(200);
    const after = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: s.headers });
    expect(after.statusCode).toBe(401);
  });

  it("stores only a hash of the session token", async () => {
    const s = await login(ctx.app);
    const rows = await ctx.handle.sql`select token_hash from sessions where user_id = ${s.userId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(s.token);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("health and OpenAPI are public", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const doc = await ctx.app.inject({ method: "GET", url: "/openapi.json" });
    expect(doc.statusCode).toBe(200);
    const spec = doc.json();
    expect(spec.openapi).toBe("3.1.0");
    for (const path of ["/v1/tasks", "/v1/sync/changes", "/v1/sync/mutations", "/v1/today", "/v1/accounts/imap", "/v1/clarifications/{id}/answer"]) {
      expect(spec.paths).toHaveProperty([path]);
    }
  });
});

describe("dev login switch", () => {
  it("is unavailable unless enabled", async () => {
    const ctx = await createTestContext({ devLogin: false });
    try {
      const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/dev", payload: { email: "x@example.test" } });
      expect(res.statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});

describe("Sign in with Apple", () => {
  const audience = "app.mailpilot.test";
  let ctx: TestContext;
  let sign: (claims: Record<string, unknown>, aud?: string) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    sign = (claims, aud = audience) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer("https://appleid.apple.com")
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    ctx = await createTestContext({ apple: new AppleTokenVerifier([audience], keys) });
  });
  afterAll(async () => ctx.close());

  const nonceHash = (raw: string) => createHash("sha256").update(raw).digest("hex");
  const signIn = (identityToken: string, nonce: string) =>
    ctx.app.inject({ method: "POST", url: "/v1/auth/apple", payload: { identityToken, nonce, platform: "ios" } });

  it("accepts a valid token and finds the same user again", async () => {
    const token = await sign({ sub: "apple-user-1", email: "relay@privaterelay.appleid.com", nonce: nonceHash("nonce-abc-123") });
    const first = await signIn(token, "nonce-abc-123");
    expect(first.statusCode).toBe(200);
    expect(first.json().user.devLogin).toBe(false);
    const token2 = await sign({ sub: "apple-user-1", nonce: nonceHash("nonce-def-456") });
    const second = await signIn(token2, "nonce-def-456");
    expect(second.json().user.id).toBe(first.json().user.id);
  });

  it("rejects a wrong nonce, a wrong audience and a forged signature", async () => {
    const wrongNonce = await sign({ sub: "apple-user-2", nonce: nonceHash("other-nonce") });
    expect((await signIn(wrongNonce, "nonce-xyz-789")).json().error.code).toBe("apple_nonce_mismatch");
    const wrongAud = await sign({ sub: "apple-user-2", nonce: nonceHash("nonce-xyz-789") }, "someone.else");
    expect((await signIn(wrongAud, "nonce-xyz-789")).statusCode).toBe(401);
    const forged = `${wrongNonce.split(".").slice(0, 2).join(".")}.AAAA`;
    expect((await signIn(forged, "other-nonce")).statusCode).toBe(401);
  });

  it("is unavailable without configured audiences", async () => {
    const plain = await createTestContext();
    try {
      const res = await plain.app.inject({ method: "POST", url: "/v1/auth/apple", payload: { identityToken: "x".repeat(40), nonce: "nonce-123" } });
      expect(res.statusCode).toBe(503);
    } finally {
      await plain.close();
    }
  });
});

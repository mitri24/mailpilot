import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@mailpilot/database";
import type { AccountServices, OAuthProvider, ProbeResult } from "../src/routes/accounts.js";
import { createTestContext, imapCapabilities, login, type TestContext } from "./helpers.js";

const probe: ProbeResult = {
  capabilities: imapCapabilities(),
  folders: [
    { providerFolderId: "INBOX", path: "INBOX", name: "Posteingang", role: "inbox", uidValidity: 7n },
    { providerFolderId: "Sent", path: "Sent", name: "Gesendet", role: "sent", uidValidity: 8n },
    { providerFolderId: "Junk", path: "Junk", name: "Spam", role: "spam", uidValidity: 9n },
    { providerFolderId: "Trash", path: "Trash", name: "Papierkorb", role: "trash", uidValidity: 10n },
    { providerFolderId: "Projekte", path: "Projekte", name: "Projekte", role: "other", uidValidity: 11n },
  ],
};

class FakeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly userAction: string,
  ) {
    super(message);
  }
}

describe("accounts", () => {
  let ctx: TestContext;
  const seenPasswords: string[] = [];
  let probeFails = false;
  const exchanged: string[] = [];

  const gmail: OAuthProvider = {
    authorizationUrl: ({ state, codeVerifier, redirectUri }) =>
      `https://accounts.example.test/auth?state=${state}&code_challenge=${createHash("sha256").update(codeVerifier).digest("base64url")}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchange: async ({ code, codeVerifier }) => {
      exchanged.push(`${code}:${codeVerifier.length}`);
      return { accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: new Date(Date.now() + 3_600_000), scope: "gmail.readonly", email: "person@gmail.example", displayName: "Person" };
    },
  };

  const services: AccountServices = {
    probeImap: async (input) => {
      seenPasswords.push(input.password);
      return probe;
    },
    probeAccount: async () => {
      if (probeFails) throw new FakeError("auth_failed", "Anmeldung abgelehnt", "App-Passwort erneuern");
      return probe;
    },
    suggest: async (email) => ({ provider: email.endsWith("@gmail.com") ? "gmail" : "imap", imap: null, confidence: "known", notes: [] }),
    oauth: { gmail },
  };

  beforeAll(async () => {
    ctx = await createTestContext({ accounts: services });
  });
  afterAll(async () => ctx.close());

  const connect = async (headers: Record<string, string>, email = "ich@schule.example") =>
    ctx.app.inject({
      method: "POST",
      url: "/v1/accounts/imap",
      headers,
      payload: { displayName: "Schule", emailAddress: email, host: "imap.schule.example", username: email, password: "app-passwort-123" },
    });

  it("connects IMAP, encrypts the password and preselects inbox and sent", async () => {
    const s = await login(ctx.app);
    const res = await connect(s.headers);
    expect(res.statusCode).toBe(200);
    const account = res.json();
    expect(account).toMatchObject({ provider: "imap", status: "active", capabilities: { incrementalSync: "imap_uid" } });
    expect(seenPasswords).toContain("app-passwort-123");

    const [row] = await ctx.handle.db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, account.id));
    expect(row!.credentialsEnc).toBeTruthy();
    expect(row!.credentialsEnc).not.toContain("app-passwort-123");

    const folders = (await ctx.app.inject({ method: "GET", url: `/v1/accounts/${account.id}/folders`, headers: s.headers })).json().folders;
    const selected = folders.filter((f: { selected: boolean }) => f.selected).map((f: { path: string }) => f.path).sort();
    expect(selected).toEqual(["INBOX", "Sent"]);

    expect((await connect(s.headers)).statusCode).toBe(409);

    const projekte = folders.find((f: { path: string }) => f.path === "Projekte");
    const inbox = folders.find((f: { path: string }) => f.path === "INBOX");
    const put = await ctx.app.inject({ method: "PUT", url: `/v1/accounts/${account.id}/folders`, headers: s.headers, payload: { selectedFolderIds: [inbox.id, projekte.id] } });
    expect(put.json().folders.filter((f: { selected: boolean }) => f.selected).map((f: { path: string }) => f.path).sort()).toEqual(["INBOX", "Projekte"]);
  });

  it("only offers markers the server supports and requires acknowledging limitations", async () => {
    const s = await login(ctx.app);
    const account = (await connect(s.headers)).json();
    const set = (marker: Record<string, unknown>) =>
      ctx.app.inject({ method: "PATCH", url: `/v1/accounts/${account.id}`, headers: s.headers, payload: { marker } });

    expect((await set({ strategy: "gmail_label", keyword: "MailPilot", folder: null, acknowledgedLimitations: true })).statusCode).toBe(400);
    expect((await set({ strategy: "imap_keyword", keyword: "MailPilot", folder: null, acknowledgedLimitations: false })).statusCode).toBe(400);
    const ok = await set({ strategy: "imap_keyword", keyword: "MailPilot", folder: null, acknowledgedLimitations: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().marker).toMatchObject({ strategy: "imap_keyword", keyword: "MailPilot" });
    expect(ok.json().markerReliable).toBe(false);
  });

  it("a failed check marks the account and tells the user what to do", async () => {
    const s = await login(ctx.app);
    const account = (await connect(s.headers)).json();
    probeFails = true;
    try {
      const res = await ctx.app.inject({ method: "POST", url: `/v1/accounts/${account.id}/check`, headers: s.headers });
      expect(res.json()).toMatchObject({ ok: false, problem: "Anmeldung abgelehnt", action: "App-Passwort erneuern" });
    } finally {
      probeFails = false;
    }
    const [dto] = (await ctx.app.inject({ method: "GET", url: "/v1/accounts", headers: s.headers })).json().accounts;
    expect(dto.status).toBe("needs_reauth");
    expect(dto.lastError).toMatchObject({ code: "auth_failed", action: "App-Passwort erneuern" });
    const today = (await ctx.app.inject({ method: "GET", url: "/v1/today", headers: s.headers })).json();
    expect(today.accountsNeedingAttention).toHaveLength(1);

    const fixed = await ctx.app.inject({ method: "POST", url: `/v1/accounts/${account.id}/check`, headers: s.headers });
    expect(fixed.json().ok).toBe(true);
  });

  it("removing an account wipes credentials but keeps tasks", async () => {
    const s = await login(ctx.app);
    const account = (await connect(s.headers)).json();
    const snap = (await ctx.app.inject({ method: "GET", url: "/v1/sync/changes", headers: s.headers })).json();
    const task = await ctx.app.inject({ method: "POST", url: "/v1/tasks", headers: s.headers, payload: { title: "Bleibt" } });
    const del = await ctx.app.inject({ method: "DELETE", url: `/v1/accounts/${account.id}`, headers: s.headers });
    expect(del.statusCode).toBe(200);
    const [row] = await ctx.handle.db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, account.id));
    expect(row).toMatchObject({ status: "removed", credentialsEnc: null });
    expect((await ctx.app.inject({ method: "GET", url: "/v1/accounts", headers: s.headers })).json().accounts).toEqual([]);
    expect((await ctx.app.inject({ method: "GET", url: `/v1/tasks/${task.json().id}`, headers: s.headers })).statusCode).toBe(200);
    const delta = (await ctx.app.inject({ method: "GET", url: `/v1/sync/changes?cursor=${snap.nextCursor}`, headers: s.headers })).json();
    expect(delta.changes.find((c: { entityType: string }) => c.entityType === "account")).toMatchObject({ op: "delete", data: null });
  });

  it("OAuth: start, callback with PKCE, single-use state, encrypted tokens", async () => {
    const s = await login(ctx.app);
    const start = await ctx.app.inject({ method: "POST", url: "/v1/accounts/oauth/gmail/start", headers: s.headers, payload: {} });
    expect(start.statusCode).toBe(200);
    const { state, authorizationUrl } = start.json();
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8787/v1/oauth/callback/gmail");

    const cb = await ctx.app.inject({ method: "GET", url: `/v1/oauth/callback/gmail?code=abc&state=${state}` });
    expect(cb.statusCode).toBe(302);
    const location = new URL(cb.headers.location as string);
    expect(location.protocol).toBe("mailpilot:");
    const accountId = location.searchParams.get("accountId");
    expect(accountId).toBeTruthy();
    expect(exchanged.at(-1)).toBe("abc:64");

    const [row] = await ctx.handle.db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, accountId!));
    expect(row).toMatchObject({ provider: "gmail", emailAddress: "person@gmail.example" });
    expect(row!.credentialsEnc).not.toContain("refresh-secret");
    expect(row!.capabilities).toBeTruthy();

    const replay = await ctx.app.inject({ method: "GET", url: `/v1/oauth/callback/gmail?code=abc&state=${state}` });
    expect(replay.headers.location).toContain("state_invalid");

    const missing = await ctx.app.inject({ method: "POST", url: "/v1/accounts/oauth/microsoft/start", headers: s.headers, payload: {} });
    expect(missing.statusCode).toBe(503);
  });

  it("suggests a setup path for an address", async () => {
    const s = await login(ctx.app);
    const res = await ctx.app.inject({ method: "GET", url: "/v1/accounts/setup-suggestion?email=a@gmail.com", headers: s.headers });
    expect(res.json().provider).toBe("gmail");
  });
});

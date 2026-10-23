import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  createOAuthTokenSource,
  exchangeCode,
  oauthScopes,
  refreshAccessToken,
  type OAuthClientConfig,
} from "../src/index.js";
import { json, mockFetch } from "./helpers/http.js";

const google: OAuthClientConfig = {
  provider: "google",
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: "test-secret",
  redirectUri: "https://mailpilot.example.com/oauth/google/callback",
};
const microsoft: OAuthClientConfig = {
  provider: "microsoft",
  clientId: "00001111-aaaa-2222-bbbb-3333cccc4444",
  clientSecret: "test-secret",
  redirectUri: "https://mailpilot.example.com/oauth/microsoft/callback",
};

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function form(body: string | null): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body ?? ""));
}

describe("OAuth", () => {
  it("Scopes je Variante: nur lesen vs. mit Markierung", () => {
    expect(oauthScopes("google", "read")).toEqual(["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"]);
    expect(oauthScopes("google", "mark")).toEqual(["openid", "email", "https://www.googleapis.com/auth/gmail.modify"]);
    expect(oauthScopes("microsoft", "read")).toEqual(["openid", "email", "offline_access", "https://graph.microsoft.com/Mail.Read"]);
    expect(oauthScopes("microsoft", "mark")).toEqual(["openid", "email", "offline_access", "https://graph.microsoft.com/Mail.ReadWrite"]);
  });

  it("Google: Autorisierungs-URL mit PKCE S256, state, access_type=offline und prompt=consent", () => {
    const auth = buildAuthorizationUrl(google, { access: "mark", loginHint: "anna@example.com" });
    const url = new URL(auth.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: google.clientId,
      redirect_uri: google.redirectUri,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/gmail.modify",
      state: auth.state,
      code_challenge: auth.codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      login_hint: "anna@example.com",
    });
    expect(auth.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(auth.codeChallenge).toBe(createHash("sha256").update(auth.codeVerifier).digest("base64url"));
    expect(auth.state.length).toBeGreaterThanOrEqual(32);
    expect(buildAuthorizationUrl(google).state).not.toBe(auth.state);
  });

  it("Microsoft: v2.0-Endpunkt mit Tenant, response_mode=query und offline_access", () => {
    const auth = buildAuthorizationUrl({ ...microsoft, tenant: "organizations" }, { access: "read", state: "fixed-state", codeVerifier: "a".repeat(43) });
    const url = new URL(auth.url);
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toBe("openid email offline_access https://graph.microsoft.com/Mail.Read");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("state")).toBe("fixed-state");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update("a".repeat(43)).digest("base64url"));
    expect(new URL(buildAuthorizationUrl(microsoft).url).pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(() => buildAuthorizationUrl(microsoft, { codeVerifier: "zu kurz" })).toThrow();
  });

  it("exchangeCode sendet Code + code_verifier und liest Tokens samt Konto aus dem ID-Token", async () => {
    const http = mockFetch(() =>
      json(200, {
        access_token: "ya29.test-access",
        expires_in: 3599,
        refresh_token: "1//test-refresh",
        scope: "openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email",
        token_type: "Bearer",
        id_token: idToken({ sub: "1234567890", email: "Anna@Example.com", email_verified: true }),
      }),
    );
    const tokens = await exchangeCode(google, { code: "4/test-code", codeVerifier: "v".repeat(43) }, { fetch: http.fetch, now: () => 1_000_000 });
    const [call] = http.requests;
    expect(call?.url.toString()).toBe("https://oauth2.googleapis.com/token");
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(form(call?.body ?? null)).toEqual({
      client_id: google.clientId,
      client_secret: "test-secret",
      grant_type: "authorization_code",
      code: "4/test-code",
      redirect_uri: google.redirectUri,
      code_verifier: "v".repeat(43),
    });
    expect(tokens).toMatchObject({
      accessToken: "ya29.test-access",
      refreshToken: "1//test-refresh",
      refreshTokenRotated: true,
      tokenType: "Bearer",
      account: { email: "anna@example.com", subject: "1234567890" },
    });
    expect(tokens.expiresAt.getTime()).toBe(1_000_000 + 3_599_000);
    expect(tokens.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("Microsoft rotiert Refresh-Tokens: refreshAccessToken liefert den neuen zurück", async () => {
    const http = mockFetch(() =>
      json(200, {
        access_token: "eyJ0-new-access",
        token_type: "Bearer",
        expires_in: 3599,
        scope: "https://graph.microsoft.com/Mail.Read",
        refresh_token: "M.R3-new-refresh",
      }),
    );
    const tokens = await refreshAccessToken(microsoft, "M.R3-old-refresh", { fetch: http.fetch, scopes: oauthScopes("microsoft", "read") });
    expect(http.requests[0]?.url.toString()).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(form(http.requests[0]?.body ?? null)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "M.R3-old-refresh",
      client_id: microsoft.clientId,
      scope: "openid email offline_access https://graph.microsoft.com/Mail.Read",
    });
    expect(tokens).toMatchObject({ accessToken: "eyJ0-new-access", refreshToken: "M.R3-new-refresh", refreshTokenRotated: true });
  });

  it("ergänzt offline_access, wenn gespeicherte Microsoft-Scopes es nicht enthalten", async () => {
    const http = mockFetch(() => json(200, { access_token: "a", token_type: "Bearer", expires_in: 3599, refresh_token: "r2" }));
    await refreshAccessToken(microsoft, "r1", { fetch: http.fetch, scopes: ["https://graph.microsoft.com/Mail.Read"] });
    expect(form(http.requests[0]?.body ?? null).scope).toBe("https://graph.microsoft.com/Mail.Read offline_access");
  });

  it("Google ohne neues Refresh-Token behält das bisherige", async () => {
    const http = mockFetch(() => json(200, { access_token: "ya29.refreshed", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.readonly", token_type: "Bearer" }));
    const tokens = await refreshAccessToken(google, "1//kept", { fetch: http.fetch });
    expect(tokens).toMatchObject({ refreshToken: "1//kept", refreshTokenRotated: false, account: null });
  });

  it("bildet Token-Fehler ab: invalid_grant → needs_reauth, invalid_client → config, 5xx → server", async () => {
    const cases: Array<[Response, string]> = [
      [json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }), "needs_reauth"],
      [json(400, { error: "interaction_required", error_description: "AADSTS50076: ..." }), "needs_reauth"],
      [json(401, { error: "invalid_client", error_description: "The OAuth client was not found." }), "config"],
      [json(503, { error: "temporarily_unavailable" }), "server"],
    ];
    for (const [response, code] of cases) {
      const http = mockFetch(() => response.clone());
      await expect(refreshAccessToken(google, "1//x", { fetch: http.fetch })).rejects.toMatchObject({ code });
    }
    const offline = mockFetch(() => Promise.reject(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })));
    await expect(refreshAccessToken(google, "1//x", { fetch: offline.fetch })).rejects.toMatchObject({ code: "network" });
  });

  it("Token-Quelle: cacht, erneuert vor Ablauf, invalidate() erzwingt Refresh, rotiertes Token wird gemeldet", async () => {
    let now = 0;
    let counter = 0;
    const http = mockFetch(async () => {
      counter += 1;
      return json(200, { access_token: `access-${counter}`, expires_in: 3600, refresh_token: `refresh-${counter}`, token_type: "Bearer" });
    });
    const persisted: string[] = [];
    const source = createOAuthTokenSource({
      config: microsoft,
      refreshToken: "refresh-0",
      fetch: http.fetch,
      now: () => now,
      onTokens: (tokens) => {
        persisted.push(tokens.refreshToken ?? "");
      },
    });
    const [a, b] = await Promise.all([source.getAccessToken(), source.getAccessToken()]);
    expect([a, b]).toEqual(["access-1", "access-1"]);
    expect(http.requests).toHaveLength(1);
    now = 3_000_000;
    expect(await source.getAccessToken()).toBe("access-1");
    now = 3_550_000;
    expect(await source.getAccessToken()).toBe("access-2");
    source.invalidate();
    expect(await source.getAccessToken()).toBe("access-3");
    expect(persisted).toEqual(["refresh-1", "refresh-2", "refresh-3"]);
    expect(http.requests.map((r) => form(r.body).refresh_token)).toEqual(["refresh-0", "refresh-1", "refresh-2"]);
  });

  it("scheitert nur das Speichern rotierter Tokens, gibt es einen Serverfehler statt „erneut verbinden“", async () => {
    const http = mockFetch(() => json(200, { access_token: "fresh", expires_in: 3600, refresh_token: "rotated", token_type: "Bearer" }));
    const source = createOAuthTokenSource({
      config: microsoft,
      refreshToken: "old",
      fetch: http.fetch,
      onTokens: () => {
        throw new Error("database unavailable");
      },
    });
    await expect(source.getAccessToken()).rejects.toMatchObject({ code: "server", userAction: "Später erneut versuchen – der Mailserver meldet einen Fehler" });
    expect(await source.getAccessToken()).toBe("fresh");
    expect(http.requests).toHaveLength(1);
  });
});

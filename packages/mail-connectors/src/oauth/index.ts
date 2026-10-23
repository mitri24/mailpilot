import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { USER_ACTION, connectorError, mapNetworkError, mapOAuthError } from "../errors.js";
import type { FetchLike } from "../http.js";
import type { OAuthTokenSource } from "../types.js";

export type OAuthProviderName = "google" | "microsoft";

/** "read": only reading mail. "mark": reading plus setting labels/categories/flags. */
export type OAuthAccess = "read" | "mark";

export interface OAuthClientConfig {
  provider: OAuthProviderName;
  clientId: string;
  /** Required for confidential web clients (Google web apps, Microsoft web apps). */
  clientSecret?: string | null;
  redirectUri: string;
  /** Microsoft only: "common" (default), "organizations", "consumers" or a tenant id. */
  tenant?: string;
}

/**
 * Scopes per variant. Google: gmail.readonly and gmail.modify are "restricted" scopes
 * (verification and, for server-side storage, a security assessment are required).
 * gmail.modify covers reading as well, so the marking variant does not add gmail.readonly.
 * Microsoft: Mail.Read / Mail.ReadWrite (delegated, no admin consent by default);
 * offline_access is needed for a refresh token. "openid email" identify the account.
 */
export const OAUTH_SCOPES: Record<OAuthProviderName, Record<OAuthAccess, readonly string[]>> = {
  google: {
    read: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    mark: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
  },
  microsoft: {
    read: ["openid", "email", "offline_access", "https://graph.microsoft.com/Mail.Read"],
    mark: ["openid", "email", "offline_access", "https://graph.microsoft.com/Mail.ReadWrite"],
  },
};

export function oauthScopes(provider: OAuthProviderName, access: OAuthAccess): string[] {
  return [...OAUTH_SCOPES[provider][access]];
}

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

function microsoftEndpoint(config: OAuthClientConfig, kind: "authorize" | "token"): string {
  const tenant = config.tenant ?? "common";
  if (!/^[A-Za-z0-9.-]+$/.test(tenant)) throw connectorError("config", "OAuth: invalid tenant");
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/${kind}`;
}

function tokenEndpoint(config: OAuthClientConfig): string {
  return config.provider === "google" ? GOOGLE_TOKEN : microsoftEndpoint(config, "token");
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** RFC 7636: 32 random bytes → 43 characters from the unreserved set. */
export function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export function codeChallengeS256(codeVerifier: string): string {
  return base64Url(createHash("sha256").update(codeVerifier, "ascii").digest());
}

export function createState(): string {
  return base64Url(randomBytes(24));
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  scopes: string[];
}

export interface AuthorizationOptions {
  access?: OAuthAccess;
  /** Overrides `access`. */
  scopes?: string[];
  state?: string;
  codeVerifier?: string;
  loginHint?: string;
  /** Google default "consent" (guarantees a refresh token), Microsoft default "select_account". */
  prompt?: string;
}

/** Builds the authorization URL with PKCE (S256) and state; store state + codeVerifier for the callback. */
export function buildAuthorizationUrl(config: OAuthClientConfig, options: AuthorizationOptions = {}): AuthorizationRequest {
  const scopes = options.scopes ?? oauthScopes(config.provider, options.access ?? "read");
  const state = options.state ?? createState();
  const codeVerifier = options.codeVerifier ?? createCodeVerifier();
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) throw connectorError("config", "OAuth: invalid PKCE code verifier");
  const codeChallenge = codeChallengeS256(codeVerifier);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  let base: string;
  if (config.provider === "google") {
    base = GOOGLE_AUTHORIZE;
    params.set("access_type", "offline");
    params.set("prompt", options.prompt ?? "consent");
  } else {
    base = microsoftEndpoint(config, "authorize");
    params.set("response_mode", "query");
    params.set("prompt", options.prompt ?? "select_account");
  }
  if (options.loginHint) params.set("login_hint", options.loginHint);
  return { url: `${base}?${params.toString()}`, state, codeVerifier, codeChallenge, scopes };
}

export interface OAuthTokens {
  accessToken: string;
  /** For Microsoft usually a new (rotated) token; for Google the previous one on refresh. */
  refreshToken: string | null;
  refreshTokenRotated: boolean;
  expiresAt: Date;
  scopes: string[];
  tokenType: string;
  idToken: string | null;
  /** From the ID token, read without signature check (received directly from the token endpoint over TLS). */
  account: { email: string | null; subject: string | null } | null;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

function decodeIdToken(idToken: string | undefined): OAuthTokens["account"] {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const candidates = [claims.email, claims.preferred_username];
    const email = candidates.find((value): value is string => typeof value === "string" && value.includes("@")) ?? null;
    const subject = typeof claims.oid === "string" ? claims.oid : typeof claims.sub === "string" ? claims.sub : null;
    return { email: email?.toLowerCase() ?? null, subject };
  } catch {
    return null;
  }
}

function parseScopes(scope: string | undefined, fallback: string[]): string[] {
  if (!scope) return fallback;
  const decoded = /%[0-9a-f]{2}/i.test(scope) ? decodeURIComponent(scope) : scope;
  return decoded.split(/\s+/).filter(Boolean);
}

export interface TokenRequestOptions {
  fetch?: FetchLike;
  now?: () => number;
}

async function tokenRequest(
  config: OAuthClientConfig,
  params: Record<string, string>,
  previousRefreshToken: string | null,
  requestedScopes: string[],
  options: TokenRequestOptions,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({ client_id: config.clientId, ...params });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint(config), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw mapNetworkError(err, "OAuth token request");
  }
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw mapNetworkError(err, "OAuth token response");
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) throw mapOAuthError(response.status, json, response.headers.get("retry-after"));
  const parsed = TokenResponse.safeParse(json);
  if (!parsed.success) throw connectorError("server", "OAuth token endpoint returned an unexpected response");
  const now = (options.now ?? Date.now)();
  const tokens = parsed.data;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefreshToken,
    refreshTokenRotated: tokens.refresh_token !== undefined && tokens.refresh_token !== previousRefreshToken,
    expiresAt: new Date(now + (tokens.expires_in ?? 3600) * 1000),
    scopes: parseScopes(tokens.scope, requestedScopes),
    tokenType: tokens.token_type ?? "Bearer",
    idToken: tokens.id_token ?? null,
    account: decodeIdToken(tokens.id_token),
  };
}

/** Redeems the authorization code (with the PKCE verifier from buildAuthorizationUrl). */
export async function exchangeCode(
  config: OAuthClientConfig,
  input: { code: string; codeVerifier: string; scopes?: string[] },
  options: TokenRequestOptions = {},
): Promise<OAuthTokens> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.redirectUri,
    code_verifier: input.codeVerifier,
  };
  if (config.provider === "microsoft" && input.scopes) params.scope = input.scopes.join(" ");
  return tokenRequest(config, params, null, input.scopes ?? [], options);
}

/**
 * Refreshes the access token. Microsoft returns a new refresh token that replaces the old one
 * (`refreshTokenRotated`); persist `refreshToken` from the result in every case.
 */
export async function refreshAccessToken(
  config: OAuthClientConfig,
  refreshToken: string,
  options: TokenRequestOptions & { scopes?: string[] } = {},
): Promise<OAuthTokens> {
  const params: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
  if (config.provider === "microsoft" && options.scopes) {
    // Scopes stored from a token response may lack offline_access; without it no new refresh token is issued.
    const scopes = options.scopes.includes("offline_access") ? options.scopes : [...options.scopes, "offline_access"];
    params.scope = scopes.join(" ");
  }
  return tokenRequest(config, params, refreshToken, options.scopes ?? [], options);
}

export interface TokenSourceOptions {
  config: OAuthClientConfig;
  refreshToken: string;
  accessToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
  fetch?: FetchLike;
  /** Called after every refresh; persist `tokens.refreshToken` (Microsoft rotates it). */
  onTokens?: (tokens: OAuthTokens) => void | Promise<void>;
  now?: () => number;
  /** Refresh this many seconds before expiry (default 60). */
  skewSeconds?: number;
}

/** In-memory OAuthTokenSource with single-flight refresh. */
export function createOAuthTokenSource(options: TokenSourceOptions): OAuthTokenSource {
  const now = options.now ?? Date.now;
  const skew = (options.skewSeconds ?? 60) * 1000;
  let accessToken = options.accessToken ?? null;
  let expiresAt = options.expiresAt?.getTime() ?? 0;
  let refreshToken = options.refreshToken;
  let inflight: Promise<string> | null = null;
  return {
    async getAccessToken(): Promise<string> {
      if (accessToken && expiresAt - skew > now()) return accessToken;
      inflight ??= (async () => {
        try {
          const tokens = await refreshAccessToken(options.config, refreshToken, {
            fetch: options.fetch,
            now,
            ...(options.scopes ? { scopes: options.scopes } : {}),
          });
          accessToken = tokens.accessToken;
          expiresAt = tokens.expiresAt.getTime();
          if (tokens.refreshToken) refreshToken = tokens.refreshToken;
          try {
            await options.onTokens?.(tokens);
          } catch (err) {
            // The refresh itself worked; asking the user to reconnect would be wrong.
            throw connectorError("server", "OAuth: storing refreshed tokens failed", { userAction: USER_ACTION.retryLater, cause: err });
          }
          return tokens.accessToken;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    invalidate(): void {
      accessToken = null;
      expiresAt = 0;
    },
  };
}

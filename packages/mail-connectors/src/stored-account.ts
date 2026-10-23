import type { CreateConnectorOptions } from "./index.js";
import { createOAuthTokenSource, oauthScopes, type OAuthClientConfig } from "./oauth/index.js";
import { ConnectorError, type ConnectorAccount } from "./types.js";

/** Credentials as the server stores them (encrypted at rest by the caller). */
export type StoredMailCredentials =
  | { kind: "imap"; password: string }
  | { kind: "oauth"; accessToken: string; refreshToken: string | null; expiresAt: string | null; scope: string | null };

export interface StoredMailAccount {
  provider: string;
  emailAddress: string;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean | null;
  imapUsername: string | null;
}

export interface OAuthClients {
  google: OAuthClientConfig | null;
  microsoft: OAuthClientConfig | null;
}

/** OAuth clients from server configuration; redirects go to the API's callback route. */
export function oauthClientsFrom(env: {
  PUBLIC_BASE_URL: string;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  MICROSOFT_CLIENT_ID?: string | undefined;
  MICROSOFT_CLIENT_SECRET?: string | undefined;
  MICROSOFT_TENANT: string;
}): OAuthClients {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return {
    google: env.GOOGLE_CLIENT_ID
      ? { provider: "google", clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET ?? null, redirectUri: `${base}/v1/oauth/callback/gmail` }
      : null,
    microsoft: env.MICROSOFT_CLIENT_ID
      ? {
          provider: "microsoft",
          clientId: env.MICROSOFT_CLIENT_ID,
          clientSecret: env.MICROSOFT_CLIENT_SECRET ?? null,
          redirectUri: `${base}/v1/oauth/callback/microsoft`,
          tenant: env.MICROSOFT_TENANT,
        }
      : null,
  };
}

/**
 * Connector input for a stored account. Refreshed OAuth tokens go to `persist`; Microsoft rotates
 * refresh tokens, so a lost write would end the connection.
 */
export function connectorAccountFromStored(
  account: StoredMailAccount,
  credentials: StoredMailCredentials,
  clients: OAuthClients,
  persist: (next: StoredMailCredentials) => Promise<void>,
): ConnectorAccount {
  if (account.provider === "imap") {
    if (credentials.kind !== "imap" || !account.imapHost || !account.imapPort || account.imapSecure === null || !account.imapUsername) {
      throw new ConnectorError("config", "IMAP-Zugangsdaten sind unvollständig", "Konto erneut verbinden");
    }
    return {
      provider: "imap",
      emailAddress: account.emailAddress,
      imap: { host: account.imapHost, port: account.imapPort, secure: account.imapSecure, username: account.imapUsername, password: credentials.password },
    };
  }
  if (account.provider !== "gmail" && account.provider !== "microsoft") {
    throw new ConnectorError("config", `Unbekannter Anbieter ${account.provider}`, "Konto erneut verbinden");
  }
  const name = account.provider === "gmail" ? "google" : "microsoft";
  const config = clients[name];
  if (!config) {
    throw new ConnectorError(
      "config",
      `${account.provider === "gmail" ? "Gmail" : "Microsoft 365"} ist auf dem Server nicht eingerichtet`,
      "OAuth-Zugangsdaten auf dem Server eintragen",
    );
  }
  if (credentials.kind !== "oauth" || !credentials.refreshToken) {
    throw new ConnectorError("needs_reauth", "Der Zugang ist abgelaufen", "Konto erneut verbinden");
  }
  const refreshToken = credentials.refreshToken;
  const tokens = createOAuthTokenSource({
    config,
    refreshToken,
    accessToken: credentials.accessToken,
    expiresAt: credentials.expiresAt ? new Date(credentials.expiresAt) : null,
    scopes: credentials.scope ? credentials.scope.split(/\s+/).filter(Boolean) : oauthScopes(name, "read"),
    onTokens: (t) =>
      persist({
        kind: "oauth",
        accessToken: t.accessToken,
        refreshToken: t.refreshToken ?? refreshToken,
        expiresAt: t.expiresAt.toISOString(),
        scope: t.scopes.join(" ") || credentials.scope,
      }),
  });
  return { provider: account.provider, emailAddress: account.emailAddress, tokens };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * TLS stays mandatory. Only a local test server on loopback may present a self-signed certificate,
 * and only when the development switch is on.
 */
export function localTestServerOptions(allowSelfSignedLoopback: boolean, account: ConnectorAccount): CreateConnectorOptions {
  return allowSelfSignedLoopback && account.provider === "imap" && LOOPBACK.has(account.imap.host) ? { imapTls: { rejectUnauthorized: false } } : {};
}

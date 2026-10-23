import { eq } from "drizzle-orm";
import {
  buildAuthorizationUrl,
  ConnectorError,
  connectorAccountFromStored,
  createConnector,
  exchangeCode,
  localTestServerOptions,
  oauthClientsFrom,
  oauthScopes,
  suggestAccountSetup,
  type ConnectorAccount,
  type OAuthClientConfig,
} from "@mailpilot/mail-connectors";
import { schema, type CredentialCipher, type Database, type StoredCredentials } from "@mailpilot/database";
import type { Config } from "./config.js";
import type { AccountServices, OAuthProvider, ProbeResult, SetupSuggestion } from "./routes/accounts.js";

type AccountRow = typeof schema.mailAccounts.$inferSelect;

async function probe(account: ConnectorAccount, allowSelfSigned: boolean): Promise<ProbeResult> {
  const connector = createConnector(account, localTestServerOptions(allowSelfSigned, account));
  try {
    const capabilities = await connector.verify();
    const folders = await connector.listFolders();
    return {
      capabilities,
      folders: folders.map((f) => ({ providerFolderId: f.providerFolderId, path: f.path, name: f.name, role: f.role, uidValidity: f.uidValidity })),
    };
  } finally {
    await connector.close().catch(() => undefined);
  }
}

function oauthProvider(client: OAuthClientConfig): OAuthProvider {
  return {
    authorizationUrl: ({ state, codeVerifier, loginHint, withMarker }) =>
      buildAuthorizationUrl(client, { state, codeVerifier, access: withMarker ? "mark" : "read", ...(loginHint ? { loginHint } : {}) }).url,
    exchange: async ({ code, codeVerifier, withMarker }) => {
      const tokens = await exchangeCode(client, { code, codeVerifier, scopes: oauthScopes(client.provider, withMarker ? "mark" : "read") });
      const email = tokens.account?.email;
      if (!email) throw new ConnectorError("config", "Der Anbieter hat keine Mailadresse übermittelt", "Konto erneut verbinden");
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scopes.join(" "),
        email,
        displayName: null,
      };
    },
  };
}

/** Mail access for the API: connection checks, OAuth, setup hints. Mail itself is only read by the worker. */
export function createAccountServices(deps: { config: Config; db: Database; cipher: CredentialCipher }): AccountServices {
  const clients = oauthClientsFrom(deps.config);
  const allowSelfSigned = deps.config.DEV_IMAP_ALLOW_SELF_SIGNED_LOCALHOST;

  const storedAccount = (row: AccountRow): ConnectorAccount => {
    if (!row.credentialsEnc) throw new ConnectorError("needs_reauth", "Für dieses Konto ist kein Zugang gespeichert", "Konto erneut verbinden");
    const credentials = deps.cipher.decrypt<StoredCredentials>(row.credentialsEnc);
    return connectorAccountFromStored(row, credentials, clients, async (next) => {
      await deps.db.update(schema.mailAccounts).set({ credentialsEnc: deps.cipher.encrypt(next), updatedAt: new Date() }).where(eq(schema.mailAccounts.id, row.id));
    });
  };

  return {
    probeImap: (input) =>
      probe({
        provider: "imap",
        emailAddress: input.emailAddress,
        imap: { host: input.host, port: input.port, secure: input.secure, username: input.username, password: input.password },
      }, allowSelfSigned),
    probeAccount: (row) => probe(storedAccount(row), allowSelfSigned),
    suggest: async (email): Promise<SetupSuggestion> => {
      const s = await suggestAccountSetup(email);
      return {
        provider: s.provider ?? "unknown",
        imap: s.imap ? { host: s.imap.host, port: s.imap.port, secure: s.imap.secure } : null,
        confidence: s.confidence === "high" ? "known" : s.confidence === "medium" ? "probable" : "unknown",
        notes: s.notes,
      };
    },
    oauth: {
      ...(clients.google ? { gmail: oauthProvider(clients.google) } : {}),
      ...(clients.microsoft ? { microsoft: oauthProvider(clients.microsoft) } : {}),
    },
    revoke: async (row, credentials) => {
      // Google documents a revocation endpoint; Microsoft grants are removed in the account's app settings.
      if (row.provider !== "gmail" || credentials.kind !== "oauth") return;
      const token = credentials.refreshToken ?? credentials.accessToken;
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    },
  };
}

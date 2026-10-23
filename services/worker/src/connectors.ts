import { eq } from "drizzle-orm";
import { connectorAccountFromStored, ConnectorError, createConnector, localTestServerOptions, type OAuthClients } from "@mailpilot/mail-connectors";
import { schema, type CredentialCipher, type Database, type StoredCredentials } from "@mailpilot/database";
import type { ConnectorFactory } from "./deps.js";

/** Opens a connector for a stored account; refreshed tokens are written back encrypted. */
export function createConnectorFactory(deps: { db: Database; cipher: CredentialCipher; clients: OAuthClients; allowSelfSignedLocalhost?: boolean }): ConnectorFactory {
  return async (account) => {
    if (!account.credentialsEnc) throw new ConnectorError("needs_reauth", "Für dieses Konto ist kein Zugang gespeichert", "Konto erneut verbinden");
    const credentials = deps.cipher.decrypt<StoredCredentials>(account.credentialsEnc);
    const connectorAccount = connectorAccountFromStored(account, credentials, deps.clients, async (next) => {
      await deps.db.update(schema.mailAccounts).set({ credentialsEnc: deps.cipher.encrypt(next), updatedAt: new Date() }).where(eq(schema.mailAccounts.id, account.id));
    });
    return createConnector(connectorAccount, localTestServerOptions(deps.allowSelfSignedLocalhost ?? false, connectorAccount));
  };
}

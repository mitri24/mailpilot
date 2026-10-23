import type { ConnectionOptions } from "node:tls";
import { GmailConnector } from "./gmail/connector.js";
import type { FetchLike } from "./http.js";
import { ImapConnector } from "./imap/connector.js";
import type { ConnectorLogger } from "./logger.js";
import { MicrosoftConnector } from "./microsoft/connector.js";
import type { ConnectorAccount, MailConnector } from "./types.js";

export * from "./types.js";
export {
  DEFAULT_MAX_MESSAGE_BYTES,
  computeContentHash,
  computeHeadersFingerprint,
  normalizeMessageId,
  normalizeText,
  processBody,
  processMime,
  reduceForAnalysis,
  sanitizeEmailHtml,
  type BodyContent,
  type MimeContent,
  type ProcessMimeOptions,
  type ReduceOptions,
  type ReducedText,
  type SanitizedHtml,
} from "./content.js";
export { USER_ACTION, connectorError, isConnectorError, parseRetryAfter } from "./errors.js";
export type { FetchLike } from "./http.js";
export { noopLogger, type ConnectorLogger } from "./logger.js";
export { COPY_MARKER_KEYWORD, ImapConnector, imapCursorKey, type ImapConnectorOptions } from "./imap/connector.js";
export type { ImapClient, ImapClientFactory } from "./imap/client.js";
export { DEFAULT_GMAIL_LABEL, GMAIL_CURSOR_KEY, GmailConnector, gmailWebLink, type GmailConnectorOptions } from "./gmail/connector.js";
export { DEFAULT_GRAPH_CATEGORY, MicrosoftConnector, graphCursorKey, type MicrosoftConnectorOptions } from "./microsoft/connector.js";
export {
  OAUTH_SCOPES,
  buildAuthorizationUrl,
  codeChallengeS256,
  createCodeVerifier,
  createOAuthTokenSource,
  createState,
  exchangeCode,
  oauthScopes,
  refreshAccessToken,
  type AuthorizationOptions,
  type AuthorizationRequest,
  type OAuthAccess,
  type OAuthClientConfig,
  type OAuthProviderName,
  type OAuthTokens,
  type TokenSourceOptions,
} from "./oauth/index.js";
export {
  parseIspdbXml,
  suggestAccountSetup,
  type AccountSetupSuggestion,
  type ImapSettingsSuggestion,
  type SetupProvider,
  type SetupResolver,
  type SuggestAccountSetupOptions,
} from "./setup.js";
export {
  FixtureConnector,
  FixtureMailbox,
  fixtureError,
  type AddMessageOptions,
  type FixtureFolderInput,
  type FixtureMailboxOptions,
  type FixtureMarkerOperation,
  type FixtureOperation,
} from "./fixture/index.js";

export {
  connectorAccountFromStored,
  localTestServerOptions,
  oauthClientsFrom,
  type OAuthClients,
  type StoredMailAccount,
  type StoredMailCredentials,
} from "./stored-account.js";

export interface CreateConnectorOptions {
  /** HTTP implementation for Gmail/Graph (tests inject a mock). */
  fetch?: FetchLike;
  /** Extra TLS options for IMAP (e.g. a test CA); TLS itself is always required. */
  imapTls?: ConnectionOptions;
  logger?: ConnectorLogger;
}

export function createConnector(account: ConnectorAccount, options: CreateConnectorOptions = {}): MailConnector {
  switch (account.provider) {
    case "imap":
      return new ImapConnector(account, {
        ...(options.imapTls ? { tls: options.imapTls } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      });
    case "gmail":
      return new GmailConnector(account, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      });
    case "microsoft":
      return new MicrosoftConnector(account, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      });
  }
}

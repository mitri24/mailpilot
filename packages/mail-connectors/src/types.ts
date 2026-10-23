import type { AccountCapabilities, FolderRole, MarkerStrategy } from "@mailpilot/contracts";

export type ProviderKind = "gmail" | "microsoft" | "imap";

export interface NormalizedAddress {
  name: string | null;
  address: string;
}

export interface NormalizedAttachment {
  filename: string | null;
  contentType: string | null;
  size: number | null;
  inline: boolean;
}

export interface RemoteFolder {
  /** IMAP mailbox path, Gmail label id or Graph folder id. */
  providerFolderId: string;
  path: string;
  name: string;
  role: FolderRole;
  /** IMAP only. */
  uidValidity: bigint | null;
}

/** Where a message currently sits. IMAP locations change on move; Gmail/Graph ids do not. */
export interface MessageLocation {
  providerFolderId: string;
  uidValidity: bigint | null;
  uid: bigint | null;
  flags: string[];
}

export interface NormalizedMessage {
  /**
   * Stable per account. Gmail: "gmail:<id>". Graph: "graph:<immutableId>".
   * IMAP: "rfc:<Message-ID>" when present, otherwise "fp:<headersFingerprint>".
   */
  identityKey: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: NormalizedAddress | null;
  to: NormalizedAddress[];
  cc: NormalizedAddress[];
  subject: string | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  /** Readable plain text; remote content removed. */
  bodyText: string;
  /** Sanitized HTML: no scripts, no event handlers, no remote images, safe links only. */
  bodyHtmlSanitized: string | null;
  remoteContentBlocked: number;
  snippet: string | null;
  attachments: NormalizedAttachment[];
  sizeBytes: number | null;
  /** sha256 over the normalized text; unchanged content is not analyzed again. */
  contentHash: string;
  /** sha256 over from, date, subject and Message-ID; fallback identity. */
  headersFingerprint: string;
  webLink: string | null;
  location: MessageLocation | null;
  /** Gmail label ids or Graph categories as seen on the server. */
  labels: string[];
  /** True when body was cut at maxMessageBytes. */
  truncated: boolean;
}

export type MailChange =
  | { kind: "upsert"; message: NormalizedMessage }
  /** The message left this folder (moved or deleted). Other locations stay valid. */
  | { kind: "location_removed"; identityKey: string | null; location: MessageLocation }
  /** The message is gone from the account entirely (Gmail/Graph delete, IMAP expunge everywhere). */
  | { kind: "deleted"; identityKey: string };

export interface FetchFolder {
  providerFolderId: string;
  role: FolderRole;
  uidValidity: bigint | null;
}

export interface FetchRequest {
  folders: FetchFolder[];
  /** Opaque cursors keyed by `${kind}:${providerFolderId}` or `${kind}:*`, as returned before. */
  cursors: Record<string, string>;
  /** Initial import window (default 14 days) used when no cursor exists or a cursor was lost. */
  since: Date;
  maxMessages: number;
  maxMessageBytes: number;
  /** Own addresses (account + aliases) – lets connectors fill isFromMe-relevant data consistently. */
  ownAddresses: string[];
}

export interface FetchResult {
  changes: MailChange[];
  cursors: Record<string, string>;
  /** Folders where the cursor was invalid (UIDVALIDITY change, expired history) and a re-import ran. */
  cursorResets: Array<{ providerFolderId: string; reason: string }>;
  uidValidity: Record<string, bigint>;
  /** false when maxMessages was reached; call again with the returned cursors. */
  complete: boolean;
}

export interface MarkerRequest {
  strategy: MarkerStrategy;
  keyword: string | null;
  folder: string | null;
  message: { providerMessageId: string | null; rfcMessageId: string | null; location: MessageLocation | null };
}

export interface MarkerResult {
  status: "applied" | "unsupported" | "failed";
  detail: string | null;
}

export type ConnectorErrorCode =
  | "auth_failed"
  | "needs_reauth"
  | "permission_denied"
  | "rate_limited"
  | "not_supported"
  | "network"
  | "tls"
  | "server"
  | "config";

/** Errors carry a German, user-facing action ("Konto erneut verbinden"). */
export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly userAction: string,
    readonly retryAfterSeconds: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConnectorError";
  }
}

export interface MailConnector {
  readonly provider: ProviderKind;
  /** Connects and authenticates; returns detected capabilities or throws ConnectorError. */
  verify(): Promise<AccountCapabilities>;
  listFolders(): Promise<RemoteFolder[]>;
  /** Never marks messages as read and never moves, copies or deletes them. */
  fetchChanges(request: FetchRequest): Promise<FetchResult>;
  applyMarker(request: MarkerRequest, operation: "set" | "clear"): Promise<MarkerResult>;
  close(): Promise<void>;
}

export interface OAuthTokenSource {
  /** Returns a valid access token, refreshing (and persisting rotated refresh tokens) when needed. */
  getAccessToken(): Promise<string>;
  /** Called after a 401 to force one refresh attempt. */
  invalidate(): void;
}

export type ConnectorAccount =
  | {
      provider: "imap";
      emailAddress: string;
      imap: { host: string; port: number; secure: boolean; username: string; password: string };
    }
  | { provider: "gmail"; emailAddress: string; tokens: OAuthTokenSource }
  | { provider: "microsoft"; emailAddress: string; tokens: OAuthTokenSource };

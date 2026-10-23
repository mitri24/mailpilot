import { ConnectorError, type ConnectorErrorCode } from "./types.js";

/** German, user-facing next steps. Kept in one place so wording stays consistent. */
export const USER_ACTION = {
  reconnect: "Konto erneut verbinden",
  checkCredentials: "Zugangsdaten oder App-Passwort prüfen",
  checkPermissions: "Berechtigungen prüfen und Konto erneut verbinden",
  reconnectWithMarking: "Konto mit Markierungsrechten erneut verbinden",
  adminApproval: "Administrator um Freigabe für MailPilot bitten",
  waitRetry: "Kurz warten – MailPilot versucht es automatisch erneut",
  checkNetwork: "Internetverbindung und Serveradresse prüfen",
  checkTls: "Sichere Verbindung fehlgeschlagen – Server, Port und Verschlüsselung prüfen",
  retryLater: "Später erneut versuchen – der Mailserver meldet einen Fehler",
  checkSettings: "Kontoeinstellungen prüfen",
  checkOAuthConfig: "OAuth-Einrichtung von MailPilot prüfen (Client-ID, Secret, Redirect-URI)",
  checkFolders: "Ordnerauswahl prüfen",
  notSupported: "Diese Funktion wird von diesem Konto nicht unterstützt",
} as const;

const DEFAULT_ACTION: Record<ConnectorErrorCode, string> = {
  auth_failed: USER_ACTION.checkCredentials,
  needs_reauth: USER_ACTION.reconnect,
  permission_denied: USER_ACTION.checkPermissions,
  rate_limited: USER_ACTION.waitRetry,
  not_supported: USER_ACTION.notSupported,
  network: USER_ACTION.checkNetwork,
  tls: USER_ACTION.checkTls,
  server: USER_ACTION.retryLater,
  config: USER_ACTION.checkSettings,
};

export function connectorError(
  code: ConnectorErrorCode,
  message: string,
  options: { userAction?: string; retryAfterSeconds?: number | null; cause?: unknown } = {},
): ConnectorError {
  return new ConnectorError(
    code,
    message,
    options.userAction ?? DEFAULT_ACTION[code],
    options.retryAfterSeconds ?? null,
    options.cause === undefined ? undefined : { cause: options.cause },
  );
}

export function isConnectorError(value: unknown): value is ConnectorError {
  return value instanceof ConnectorError;
}

/** Retry-After is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

interface ErrorDetails {
  code: string | null;
  reasons: string[];
  message: string | null;
}

/** Reads Google ({error:{code,errors[].reason}}), Graph ({error:{code,innerError}}) and OAuth ({error}) bodies. */
export function readErrorBody(body: unknown): ErrorDetails {
  const details: ErrorDetails = { code: null, reasons: [], message: null };
  if (!body || typeof body !== "object") return details;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") {
    details.code = error;
    const description = (body as { error_description?: unknown }).error_description;
    if (typeof description === "string") details.message = description;
    return details;
  }
  if (!error || typeof error !== "object") return details;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string") details.code = record.code;
  if (typeof record.message === "string") details.message = record.message;
  if (typeof record.status === "string") details.reasons.push(record.status);
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      const reason = (item as { reason?: unknown } | null)?.reason;
      if (typeof reason === "string") details.reasons.push(reason);
    }
  }
  let inner = (record.innerError ?? record.innererror) as Record<string, unknown> | undefined;
  for (let depth = 0; inner && typeof inner === "object" && depth < 5; depth++) {
    if (typeof inner.code === "string") details.reasons.push(inner.code);
    inner = (inner.innerError ?? inner.innererror) as Record<string, unknown> | undefined;
  }
  return details;
}

const GOOGLE_RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]);

export type HttpProvider = "gmail" | "microsoft";

/** Maps a non-2xx API response (after the 401 refresh retry) to a ConnectorError. */
export function mapHttpError(
  provider: HttpProvider,
  status: number,
  body: unknown,
  retryAfterHeader: string | null,
): ConnectorError {
  const details = readErrorBody(body);
  const label = provider === "gmail" ? "Gmail API" : "Microsoft Graph";
  const summary = `${label} responded ${status}${details.code ? ` (${details.code})` : ""}${
    details.reasons.length ? ` [${details.reasons.join(", ")}]` : ""
  }`;
  const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
  if (status === 401) return connectorError("needs_reauth", summary);
  if (status === 429) return connectorError("rate_limited", summary, { retryAfterSeconds });
  if (status === 403) {
    if (provider === "gmail" && details.reasons.some((reason) => GOOGLE_RATE_REASONS.has(reason))) {
      return connectorError("rate_limited", summary, { retryAfterSeconds });
    }
    if (provider === "gmail" && details.reasons.includes("domainPolicy")) {
      return connectorError("permission_denied", summary, { userAction: USER_ACTION.adminApproval });
    }
    return connectorError("permission_denied", summary);
  }
  if (status === 503 && retryAfterSeconds !== null) return connectorError("rate_limited", summary, { retryAfterSeconds });
  // Conflicts, gone resources and locks are transient from the account's point of view.
  if (status >= 500 || [408, 409, 410, 412, 423, 425].includes(status)) return connectorError("server", summary);
  return connectorError("config", summary);
}

const TLS_CODES = new Set([
  "EPROTO",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "STARTTLS_INJECTION",
]);

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectText",
  "ClosedAfterConnectTLS",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "ETIMEOUT",
  "ProxyError",
  "EPROXY",
]);

function isTlsCode(code: string): boolean {
  return TLS_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || code.startsWith("CERT_");
}

/** Walks `cause` chains (fetch wraps socket errors in TypeError("fetch failed")). */
function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** Maps transport failures (fetch, sockets, TLS, timeouts) to network/tls errors. */
export function mapNetworkError(err: unknown, context: string): ConnectorError {
  if (isConnectorError(err)) return err;
  const codes = errorCodes(err);
  const name = (err as { name?: unknown } | null)?.name;
  const summary = `${context}: ${codes[0] ?? (typeof name === "string" ? name : "network failure")}`;
  if (codes.some(isTlsCode)) return connectorError("tls", summary, { cause: err });
  if (name === "TimeoutError" || name === "AbortError" || codes.some((code) => NETWORK_CODES.has(code))) {
    return connectorError("network", summary, { cause: err });
  }
  return connectorError("network", summary, { cause: err });
}

interface ImapErrorShape {
  code?: string;
  authenticationFailed?: boolean;
  tlsFailed?: boolean;
  serverResponseCode?: string;
  responseText?: string;
  throttleReset?: number;
  mailboxMissing?: boolean;
  message?: string;
}

/** Maps imapflow errors (see ImapFlowErrorCode) and socket errors to ConnectorError. */
export function mapImapError(err: unknown, context: string): ConnectorError {
  if (isConnectorError(err)) return err;
  const e = (err && typeof err === "object" ? err : {}) as ImapErrorShape;
  const codes = errorCodes(err);
  const responseCode = (e.serverResponseCode ?? "").toUpperCase();
  const summary = `${context}: ${[codes[0], responseCode].filter(Boolean).join(" ") || e.message || "IMAP error"}`;
  if (e.authenticationFailed || responseCode === "AUTHENTICATIONFAILED" || responseCode === "AUTHORIZATIONFAILED" || responseCode === "EXPIRED") {
    return connectorError("auth_failed", summary, { cause: err });
  }
  if (e.tlsFailed || responseCode === "PRIVACYREQUIRED" || codes.some(isTlsCode)) {
    return connectorError("tls", summary, { cause: err });
  }
  if (codes.includes("ETHROTTLE") || responseCode === "LIMIT") {
    const retryAfterSeconds = typeof e.throttleReset === "number" ? Math.max(1, Math.ceil(e.throttleReset / 1000)) : null;
    return connectorError("rate_limited", summary, { retryAfterSeconds, cause: err });
  }
  if (codes.some((code) => NETWORK_CODES.has(code))) return connectorError("network", summary, { cause: err });
  if (e.mailboxMissing || responseCode === "NONEXISTENT") {
    return connectorError("config", summary, { userAction: USER_ACTION.checkFolders, cause: err });
  }
  if (responseCode === "NOPERM" || responseCode === "CONTACTADMIN") {
    return connectorError("permission_denied", summary, { userAction: USER_ACTION.checkSettings, cause: err });
  }
  return connectorError("server", summary, { cause: err });
}

/** OAuth token endpoint errors (RFC 6749 §5.2 plus Microsoft's non-standard codes). */
export function mapOAuthError(status: number, body: unknown, retryAfterHeader: string | null): ConnectorError {
  const details = readErrorBody(body);
  const summary = `OAuth token endpoint responded ${status}${details.code ? ` (${details.code})` : ""}`;
  switch (details.code) {
    case "invalid_grant":
    case "interaction_required":
    case "consent_required":
    case "login_required":
      return connectorError("needs_reauth", summary);
    case "invalid_client":
    case "unauthorized_client":
    case "unsupported_grant_type":
    case "invalid_request":
    case "invalid_scope":
      return connectorError("config", summary, { userAction: USER_ACTION.checkOAuthConfig });
    case "temporarily_unavailable":
      return connectorError("server", summary, { retryAfterSeconds: parseRetryAfter(retryAfterHeader) });
    default:
      break;
  }
  if (status === 429) return connectorError("rate_limited", summary, { retryAfterSeconds: parseRetryAfter(retryAfterHeader) });
  if (status >= 500) return connectorError("server", summary);
  if (status === 401) return connectorError("config", summary, { userAction: USER_ACTION.checkOAuthConfig });
  return connectorError("needs_reauth", summary);
}

import { describe, expect, it } from "vitest";
import { mapHttpError, mapImapError, mapNetworkError, mapOAuthError, parseRetryAfter } from "../src/errors.js";

describe("Fehlerabbildung", () => {
  it("Retry-After als Sekunden oder HTTP-Datum", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("Thu, 22 Oct 2026 12:01:30 GMT", now)).toBe(90);
    expect(parseRetryAfter("Thu, 22 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("bald", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it("IMAP: Anmeldung, TLS, Drosselung, Netzwerk, fehlender Ordner, Serverfehler", () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [Object.assign(new Error("Authentication failed"), { authenticationFailed: true }), { code: "auth_failed", userAction: "Zugangsdaten oder App-Passwort prüfen" }],
      [Object.assign(new Error("Command failed"), { serverResponseCode: "AUTHENTICATIONFAILED" }), { code: "auth_failed" }],
      [Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true }), { code: "tls" }],
      [Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }), { code: "tls" }],
      [Object.assign(new Error("wrong version number"), { code: "ERR_SSL_WRONG_VERSION_NUMBER" }), { code: "tls" }],
      [Object.assign(new Error("Throttled"), { code: "ETHROTTLE", throttleReset: 30_500 }), { code: "rate_limited", retryAfterSeconds: 31 }],
      [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), { code: "network", userAction: "Internetverbindung und Serveradresse prüfen" }],
      [Object.assign(new Error("Connection not available"), { code: "NoConnection" }), { code: "network" }],
      [Object.assign(new Error("Mailbox does not exist"), { mailboxMissing: true }), { code: "config", userAction: "Ordnerauswahl prüfen" }],
      [Object.assign(new Error("Command failed"), { responseStatus: "NO", serverResponseCode: "UNAVAILABLE" }), { code: "server" }],
    ];
    for (const [error, expected] of cases) expect(mapImapError(error, "test")).toMatchObject(expected);
  });

  it("fetch-Fehler: Ursache in der cause-Kette, Zeitüberschreitung", () => {
    expect(mapNetworkError(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }), "test")).toMatchObject({ code: "network" });
    expect(mapNetworkError(new TypeError("fetch failed", { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }), "test")).toMatchObject({ code: "tls" });
    expect(mapNetworkError(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }), "test")).toMatchObject({ code: "network" });
  });

  it("HTTP-Statuscodes je Anbieter", () => {
    expect(mapHttpError("microsoft", 401, null, null)).toMatchObject({ code: "needs_reauth", userAction: "Konto erneut verbinden" });
    expect(mapHttpError("microsoft", 403, { error: { code: "ErrorAccessDenied" } }, null)).toMatchObject({ code: "permission_denied" });
    expect(mapHttpError("microsoft", 429, null, "7")).toMatchObject({ code: "rate_limited", retryAfterSeconds: 7 });
    expect(mapHttpError("microsoft", 503, null, "15")).toMatchObject({ code: "rate_limited", retryAfterSeconds: 15 });
    expect(mapHttpError("microsoft", 503, null, null)).toMatchObject({ code: "server" });
    expect(mapHttpError("microsoft", 409, null, null)).toMatchObject({ code: "server" });
    expect(mapHttpError("gmail", 403, { error: { errors: [{ reason: "dailyLimitExceeded" }] } }, null)).toMatchObject({ code: "rate_limited" });
    expect(mapHttpError("gmail", 400, { error: { code: 400, message: "Invalid", errors: [{ reason: "badRequest" }] } }, null)).toMatchObject({ code: "config" });
  });

  it("OAuth-Token-Endpunkt", () => {
    expect(mapOAuthError(400, { error: "consent_required" }, null)).toMatchObject({ code: "needs_reauth" });
    expect(mapOAuthError(400, { error: "invalid_scope" }, null)).toMatchObject({ code: "config", userAction: "OAuth-Einrichtung von MailPilot prüfen (Client-ID, Secret, Redirect-URI)" });
    expect(mapOAuthError(429, { error: "slow_down" }, "60")).toMatchObject({ code: "rate_limited", retryAfterSeconds: 60 });
  });
});

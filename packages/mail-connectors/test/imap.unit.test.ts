import { describe, expect, it } from "vitest";
import { ConnectorError, ImapConnector, type FetchRequest, type FetchResult, type NormalizedMessage } from "../src/index.js";
import { UidSet } from "../src/imap/uid-set.js";
import { FakeImapServer } from "./helpers/fake-imap.js";

const account = {
  provider: "imap" as const,
  emailAddress: "anna@example.com",
  imap: { host: "imap.example.com", port: 993, secure: true, username: "anna@example.com", password: "test-only" },
};

function raw(id: string, subject = `Betreff ${id}`): string {
  return [
    "From: Max Muster <max@example.org>",
    "To: anna@example.com",
    `Subject: ${subject}`,
    "Date: Thu, 22 Oct 2026 10:15:00 +0200",
    `Message-ID: <${id}@example.org>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Inhalt ${id}`,
    "",
  ].join("\r\n");
}

function request(cursors: Record<string, string> = {}, overrides: Partial<FetchRequest> = {}): FetchRequest {
  return {
    folders: [{ providerFolderId: "INBOX", role: "inbox", uidValidity: null }],
    cursors,
    since: new Date(Date.now() - 14 * 86_400_000),
    maxMessages: 50,
    maxMessageBytes: 100_000,
    ownAddresses: ["anna@example.com"],
    ...overrides,
  };
}

const upserts = (result: FetchResult): NormalizedMessage[] => result.changes.flatMap((c) => (c.kind === "upsert" ? [c.message] : []));

function setup(extensions: string[] = []): { server: FakeImapServer; connector: ImapConnector } {
  const server = new FakeImapServer();
  for (const extension of extensions) server.enableable.add(extension);
  server.addMailbox("INBOX");
  const connector = new ImapConnector(account, { createClient: server.factory() });
  return { server, connector };
}

describe("IMAP-Connector (gemockter Client)", () => {
  it("erzwingt TLS: secure=false nur mit STARTTLS-Pflicht, TLS-Optionen nur wenn injiziert", async () => {
    const server = new FakeImapServer();
    server.addMailbox("INBOX");
    await new ImapConnector({ ...account, imap: { ...account.imap, port: 143, secure: false } }, { createClient: server.factory() }).verify();
    await new ImapConnector(account, { createClient: server.factory() }).verify();
    const ca = "-----BEGIN CERTIFICATE-----test-----END CERTIFICATE-----";
    await new ImapConnector(account, { createClient: server.factory(), tls: { ca } }).verify();
    const [starttls, implicit, injected] = server.clientOptions;
    expect(starttls).toMatchObject({ secure: false, doSTARTTLS: true, port: 143 });
    expect(implicit?.secure).toBe(true);
    expect(implicit).not.toHaveProperty("doSTARTTLS");
    expect(implicit).not.toHaveProperty("tls");
    expect(injected?.tls).toEqual({ ca });
  });

  it("bildet IMAP-Anmeldefehler auf auth_failed mit deutscher Handlungsanweisung ab", async () => {
    const { server, connector } = setup();
    server.authFail = true;
    const error = await connector.verify().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: "auth_failed", userAction: "Zugangsdaten oder App-Passwort prüfen" });
  });

  it("liest nur per EXAMINE (readOnly) und meldet Flag-Änderungen über CONDSTORE (CHANGEDSINCE)", async () => {
    const { server, connector } = setup(["CONDSTORE"]);
    const first = server.append("INBOX", raw("a"));
    server.append("INBOX", raw("b"));
    expect((await connector.verify()).incrementalSync).toBe("imap_condstore");

    const initial = await connector.fetchChanges(request());
    expect(upserts(initial)).toHaveLength(2);
    const modseqAfterImport = server.box("INBOX").highestModseq;

    server.setFlags("INBOX", first, ["\\Flagged"]);
    const changed = await connector.fetchChanges(request(initial.cursors));
    expect(changed.changes).toHaveLength(1);
    expect(upserts(changed)[0]).toMatchObject({ identityKey: "rfc:a@example.org", location: { flags: ["\\Flagged"] } });
    const changedSinceCalls = server.callsOf("fetchAll").filter((call) => (call.args[2] as { changedSince?: bigint }).changedSince !== undefined);
    expect(changedSinceCalls.at(-1)?.args[2]).toMatchObject({ uid: true, changedSince: modseqAfterImport });

    const quiet = await connector.fetchChanges(request(changed.cursors));
    expect(quiet.changes).toEqual([]);

    const fetchLocks = server.callsOf("getMailboxLock").filter((call) => (call.args[1] as { readOnly?: boolean }).readOnly);
    expect(fetchLocks.length).toBeGreaterThan(0);
    // Only verify() opens INBOX read-write (to read PERMANENTFLAGS); fetching never does.
    expect(server.callsOf("getMailboxLock").filter((call) => !(call.args[1] as { readOnly?: boolean }).readOnly)).toHaveLength(1);
    expect(server.callsOf("messageFlagsAdd")).toEqual([]);
  });

  it("erkennt Expunge per UID SEARCH ohne QRESYNC und per VANISHED (EARLIER) mit QRESYNC", async () => {
    for (const extensions of [[], ["CONDSTORE", "QRESYNC"]]) {
      const { server, connector } = setup(extensions);
      const gone = server.append("INBOX", raw("gone"));
      server.append("INBOX", raw("stays"));
      const initial = await connector.fetchChanges(request());
      server.expunge("INBOX", gone);
      const searchesBefore = server.callsOf("search").length;
      const result = await connector.fetchChanges(request(initial.cursors));
      expect(result.changes).toEqual([
        { kind: "location_removed", identityKey: null, location: { providerFolderId: "INBOX", uidValidity: 1000n, uid: BigInt(gone), flags: [] } },
      ]);
      const knownSearches = server.callsOf("search").slice(searchesBefore).filter((call) => {
        const query = call.args[0] as { uid?: string; since?: Date };
        return query.uid !== undefined && !String(query.uid).endsWith(":*");
      });
      expect(knownSearches.length).toBe(extensions.includes("QRESYNC") ? 0 : 1);
    }
  });

  it("setzt einen unterbrochenen Flag-Scan fort und verliert dabei keine Änderung", async () => {
    const { server, connector } = setup(["CONDSTORE"]);
    const uids = ["m1", "m2", "m3", "m4", "m5"].map((id) => server.append("INBOX", raw(id)));
    let cursors = (await connector.fetchChanges(request())).cursors;
    for (const uid of uids) server.setFlags("INBOX", uid, ["\\Answered"]);
    const seen: string[] = [];
    const completes: boolean[] = [];
    for (let round = 0; round < 3; round++) {
      const result = await connector.fetchChanges(request(cursors, { maxMessages: 2 }));
      seen.push(...upserts(result).map((m) => m.identityKey));
      completes.push(result.complete);
      cursors = result.cursors;
      // A change during the interrupted scan to an already re-sent message must still arrive later.
      if (round === 0) server.setFlags("INBOX", uids[0] as number, ["\\Answered", "\\Flagged"]);
    }
    expect(completes).toEqual([false, false, true]);
    expect(seen).toEqual(["m1", "m2", "m3", "m4", "m5"].map((id) => `rfc:${id}@example.org`));
    const next = await connector.fetchChanges(request(cursors));
    expect(upserts(next).map((m) => [m.identityKey, m.location?.flags])).toEqual([["rfc:m1@example.org", ["\\Answered", "\\Flagged"]]]);
    expect(upserts(await connector.fetchChanges(request(next.cursors)))).toEqual([]);
  });

  it("UIDVALIDITY-Wechsel: cursorResets, location_removed mit alter UIDVALIDITY und Neuimport im Fenster", async () => {
    const { server, connector } = setup();
    server.append("INBOX", raw("old"), { internalDate: new Date(Date.now() - 40 * 86_400_000) });
    const recent = server.append("INBOX", raw("recent"));
    const initial = await connector.fetchChanges(request());
    expect(upserts(initial).map((m) => m.identityKey)).toEqual(["rfc:recent@example.org"]);

    server.resetUidValidity("INBOX");
    const result = await connector.fetchChanges(request(initial.cursors));
    expect(result.cursorResets).toEqual([{ providerFolderId: "INBOX", reason: "uidvalidity_changed" }]);
    expect(result.uidValidity.INBOX).toBe(1001n);
    expect(result.changes[0]).toEqual({
      kind: "location_removed",
      identityKey: null,
      location: { providerFolderId: "INBOX", uidValidity: 1000n, uid: BigInt(recent), flags: [] },
    });
    expect(upserts(result).map((m) => [m.identityKey, m.location?.uidValidity])).toEqual([["rfc:recent@example.org", 1001n]]);
  });

  it("meldet beschädigte Cursor als cursor_invalid und importiert neu", async () => {
    const { server, connector } = setup();
    server.append("INBOX", raw("x"));
    const result = await connector.fetchChanges(request({ "imap:INBOX": "{kaputt" }));
    expect(result.cursorResets).toEqual([{ providerFolderId: "INBOX", reason: "cursor_invalid" }]);
    expect(upserts(result)).toHaveLength(1);
  });

  it("ohne \\* in PERMANENTFLAGS: keine Schlagwörter, \\Flagged weiter möglich", async () => {
    const server = new FakeImapServer();
    server.addMailbox("INBOX", { permanentFlags: ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"] });
    const uid = server.append("INBOX", raw("p"));
    const connector = new ImapConnector(account, { createClient: server.factory() });
    const capabilities = await connector.verify();
    expect(capabilities.customKeywords).toBe(false);
    expect(capabilities.supportedMarkers).toEqual(["none", "imap_flagged", "imap_copy_folder"]);
    expect(capabilities.notes[0]).toContain("PERMANENTFLAGS ohne \\*");

    const message = { providerMessageId: null, rfcMessageId: "<p@example.org>", location: { providerFolderId: "INBOX", uidValidity: 1000n, uid: BigInt(uid), flags: [] } };
    expect(await connector.applyMarker({ strategy: "imap_keyword", keyword: "$MailPilot", folder: null, message }, "set")).toMatchObject({ status: "unsupported" });
    expect(await connector.applyMarker({ strategy: "imap_flagged", keyword: null, folder: null, message }, "set")).toEqual({ status: "applied", detail: null });
    expect([...(server.box("INBOX").messages.get(uid)?.flags ?? [])]).toEqual(["\\Flagged"]);
  });

  it("\\Flagged: bereits markierte Nachricht meldet already_present; veraltete UIDVALIDITY schlägt fehl", async () => {
    const { server, connector } = setup();
    const uid = server.append("INBOX", raw("f"), { flags: ["\\Flagged"] });
    const location = { providerFolderId: "INBOX", uidValidity: 1000n, uid: BigInt(uid), flags: [] };
    const marker = { strategy: "imap_flagged" as const, keyword: null, folder: null, message: { providerMessageId: null, rfcMessageId: null, location } };
    expect(await connector.applyMarker(marker, "set")).toEqual({ status: "applied", detail: "already_present" });
    const stale = { ...marker, message: { ...marker.message, location: { ...location, uidValidity: 999n } } };
    expect(await connector.applyMarker(stale, "set")).toMatchObject({ status: "failed" });
    expect(await connector.applyMarker({ ...marker, strategy: "gmail_label" }, "set")).toMatchObject({ status: "unsupported" });
  });

  it("Kopie-Marker: Aufheben ohne UIDPLUS ist nicht möglich", async () => {
    const { server, connector } = setup();
    server.capabilities.delete("UIDPLUS");
    const uid = server.append("INBOX", raw("c"));
    const marker = {
      strategy: "imap_copy_folder" as const,
      keyword: null,
      folder: "MailPilot",
      message: { providerMessageId: null, rfcMessageId: "<c@example.org>", location: { providerFolderId: "INBOX", uidValidity: 1000n, uid: BigInt(uid), flags: [] } },
    };
    expect(await connector.applyMarker(marker, "set")).toEqual({ status: "applied", detail: null });
    expect(server.box("MailPilot").messages.size).toBe(1);
    expect(await connector.applyMarker(marker, "clear")).toMatchObject({ status: "unsupported" });
    expect(server.box("MailPilot").messages.size).toBe(1);
  });

  it("Verbindungsabbruch mitten im Abgleich: Fehler statt leerer Antworten und kaputtem Cursor", async () => {
    const { server, connector } = setup();
    for (const id of ["d1", "d2", "d3"]) server.append("INBOX", raw(id));
    const initial = await connector.fetchChanges(request());
    server.append("INBOX", raw("d4"));
    server.onLock = () => server.dropConnections();
    await expect(connector.fetchChanges(request(initial.cursors))).rejects.toMatchObject({ code: "network" });
    // Dropped between commands: imapflow's SEARCH then resolves with undefined, which must not mean "empty".
    server.onSearch = () => server.dropConnections();
    await expect(connector.fetchChanges(request(initial.cursors))).rejects.toMatchObject({ code: "network" });
    const retry = await connector.fetchChanges(request(initial.cursors));
    expect(retry.changes.filter((c) => c.kind === "location_removed")).toEqual([]);
    expect(upserts(retry).map((m) => m.identityKey)).toEqual(["rfc:d4@example.org"]);
  });

  it("führt aufgeteilte bzw. eingeschobene FETCH-Antworten je UID zusammen", async () => {
    const { server, connector } = setup(["CONDSTORE", "QRESYNC"]);
    server.interleaveRows = true;
    server.append("INBOX", raw("r1", "Wichtig r1"));
    const [message] = upserts(await connector.fetchChanges(request()));
    expect(message).toMatchObject({ identityKey: "rfc:r1@example.org", subject: "Wichtig r1", bodyText: "Inhalt r1", location: { flags: ["\\Answered", "\\Seen"] } });
  });

  it("ohne UIDNEXT bleibt der Cursor gültig und überspringt nichts", async () => {
    const { server, connector } = setup();
    server.omitUidNext = true;
    server.append("INBOX", raw("n1"));
    const first = await connector.fetchChanges(request());
    expect(JSON.parse(first.cursors["imap:INBOX"] ?? "{}")).toMatchObject({ last: 1 });
    server.append("INBOX", raw("n2"));
    const second = await connector.fetchChanges(request(first.cursors));
    expect([second.cursorResets, upserts(second).map((m) => m.identityKey)]).toEqual([[], ["rfc:n2@example.org"]]);
  });

  it("Gmail über IMAP (X-GM-EXT-1): keine „Kopie in Ordner“-Strategie", async () => {
    const { server, connector } = setup();
    server.capabilities.set("X-GM-EXT-1", true);
    const uid = server.append("INBOX", raw("g"));
    const capabilities = await connector.verify();
    expect(capabilities).toMatchObject({ copyToFolder: false, supportedMarkers: ["none", "imap_keyword", "imap_flagged"] });
    const marker = {
      strategy: "imap_copy_folder" as const,
      keyword: null,
      folder: "MailPilot",
      message: { providerMessageId: null, rfcMessageId: "<g@example.org>", location: { providerFolderId: "INBOX", uidValidity: 1000n, uid: BigInt(uid), flags: [] } },
    };
    expect(await connector.applyMarker(marker, "set")).toMatchObject({ status: "unsupported" });
    expect(server.callsOf("messageCopy")).toEqual([]);
  });

  it("das Kopie-Schlüsselwort ist als eigenes Schlagwort gesperrt; Aufheben sucht und löscht in einer Sitzung", async () => {
    const { server, connector } = setup();
    const uid = server.append("INBOX", raw("k"));
    const location = { providerFolderId: "INBOX", uidValidity: 1000n, uid: BigInt(uid), flags: [] };
    const message = { providerMessageId: null, rfcMessageId: "<k@example.org>", location };
    expect(await connector.applyMarker({ strategy: "imap_keyword", keyword: "$mailpilotcopy", folder: null, message }, "set")).toMatchObject({ status: "failed" });
    const copy = { strategy: "imap_copy_folder" as const, keyword: null, folder: "MailPilot", message };
    expect(await connector.applyMarker(copy, "set")).toEqual({ status: "applied", detail: null });
    const before = server.calls.length;
    expect(await connector.applyMarker(copy, "clear")).toEqual({ status: "applied", detail: null });
    const clearCalls = server.calls.slice(before).map((call) => call.method);
    expect(clearCalls).toEqual(["getMailboxLock", "search", "messageDelete"]);
    expect(server.calls[before]?.args).toEqual(["MailPilot", {}]);
    expect(server.box("MailPilot").messages.size).toBe(0);
  });

  it("UID-Mengen: große zusammenhängende Bereiche bleiben kompakt, beschädigte Mengen werden abgelehnt", () => {
    const set = UidSet.parse("1:400000");
    expect(set?.size).toBe(400_000);
    expect(set?.toString()).toBe("1:400000");
    expect(UidSet.parse("1:600000")).toBeNull();
    expect(UidSet.parse("5:3")).toBeNull();
    expect(UidSet.parse("x")).toBeNull();
    expect(UidSet.from([5, 1, 2, 3, 9]).chunks(4)).toEqual(["1:3", "5,9"]);
  });
});

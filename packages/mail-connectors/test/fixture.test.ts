import { describe, expect, it } from "vitest";
import { ConnectorError, FixtureConnector, FixtureMailbox, fixtureError, type FetchRequest, type FetchResult, type NormalizedMessage } from "../src/index.js";

function eml(id: string, subject = `Betreff ${id}`): string {
  return `From: Max Muster <max@example.org>\r\nTo: anna@example.com\r\nSubject: ${subject}\r\nDate: Thu, 22 Oct 2026 10:15:00 +0200\r\nMessage-ID: <${id}@example.org>\r\n\r\nBitte ${id} erledigen.\r\n`;
}

function request(folders: string[], cursors: Record<string, string> = {}, maxMessages = 50): FetchRequest {
  return {
    folders: folders.map((id) => ({ providerFolderId: id, role: id === "INBOX" ? "inbox" : "other", uidValidity: null })),
    cursors,
    since: new Date("2026-10-09T00:00:00Z"),
    maxMessages,
    maxMessageBytes: 100_000,
    ownAddresses: ["anna@example.com"],
  };
}

const upserts = (result: FetchResult): NormalizedMessage[] => result.changes.flatMap((c) => (c.kind === "upsert" ? [c.message] : []));
const recent = new Date("2026-10-22T08:15:00Z");

describe("FixtureMailbox / FixtureConnector", () => {
  it("Erstimport nur im Fenster, danach nur Neues seit dem Cursor", async () => {
    const mailbox = new FixtureMailbox();
    const added = await mailbox.addMessage("INBOX", eml("a"), { receivedAt: recent });
    await mailbox.addMessage("INBOX", eml("old"), { receivedAt: new Date("2026-09-01T00:00:00Z") });
    expect(added).toMatchObject({ identityKey: "rfc:a@example.org", subject: "Betreff a", location: { providerFolderId: "INBOX", uid: 1n, uidValidity: 1n } });

    const connector = new FixtureConnector(mailbox);
    const first = await connector.fetchChanges(request(["INBOX"]));
    expect(upserts(first).map((m) => m.identityKey)).toEqual(["rfc:a@example.org"]);
    expect(first).toMatchObject({ complete: true, cursorResets: [], uidValidity: { INBOX: 1n } });

    expect((await connector.fetchChanges(request(["INBOX"], first.cursors))).changes).toEqual([]);
    await mailbox.addMessage("INBOX", eml("b"), { receivedAt: recent, flags: ["\\Seen"] });
    const second = await connector.fetchChanges(request(["INBOX"], first.cursors));
    expect(upserts(second).map((m) => [m.identityKey, m.location?.flags])).toEqual([["rfc:b@example.org", ["\\Seen"]]]);
  });

  it("Verschieben: location_removed im alten Ordner + upsert mit gleicher identityKey; Löschen: deleted", async () => {
    const mailbox = new FixtureMailbox({ folders: [{ providerFolderId: "INBOX" }, { providerFolderId: "Archive", role: "archive" }] });
    await mailbox.addMessage("INBOX", eml("m"), { receivedAt: recent });
    await mailbox.addMessage("INBOX", eml("d"), { receivedAt: recent });
    const connector = new FixtureConnector(mailbox);
    const first = await connector.fetchChanges(request(["INBOX", "Archive"]));
    mailbox.moveMessage("rfc:m@example.org", "Archive");
    mailbox.deleteMessage("rfc:d@example.org");
    const second = await connector.fetchChanges(request(["INBOX", "Archive"], first.cursors));
    expect(second.changes).toEqual([
      { kind: "deleted", identityKey: "rfc:d@example.org" },
      { kind: "location_removed", identityKey: null, location: { providerFolderId: "INBOX", uidValidity: 1n, uid: 1n, flags: [] } },
      expect.objectContaining({
        kind: "upsert",
        message: expect.objectContaining({ identityKey: "rfc:m@example.org", location: expect.objectContaining({ providerFolderId: "Archive", uid: 1n }) }),
      }),
    ]);
  });

  it("maxMessages begrenzt Import und Replay, complete=false bis alles abgeholt ist", async () => {
    const mailbox = new FixtureMailbox();
    for (const id of ["1", "2", "3"]) await mailbox.addMessage("INBOX", eml(id), { receivedAt: recent });
    const connector = new FixtureConnector(mailbox);
    const first = await connector.fetchChanges(request(["INBOX"], {}, 2));
    expect([upserts(first).length, first.complete]).toEqual([2, false]);
    const second = await connector.fetchChanges(request(["INBOX"], first.cursors, 2));
    expect([upserts(second).map((m) => m.identityKey), second.complete]).toEqual([["rfc:3@example.org"], true]);
    for (const id of ["4", "5", "6"]) await mailbox.addMessage("INBOX", eml(id), { receivedAt: recent });
    const third = await connector.fetchChanges(request(["INBOX"], second.cursors, 2));
    const fourth = await connector.fetchChanges(request(["INBOX"], third.cursors, 2));
    expect([...upserts(third), ...upserts(fourth)].map((m) => m.identityKey)).toEqual(["4", "5", "6"].map((id) => `rfc:${id}@example.org`));
    expect([third.complete, fourth.complete]).toEqual([false, true]);
  });

  it("setFailure wirft den ConnectorError (auch nur einmal oder nur für bestimmte Operationen)", async () => {
    const mailbox = new FixtureMailbox();
    const connector = new FixtureConnector(mailbox);
    mailbox.setFailure(fixtureError("needs_reauth", "Konto erneut verbinden"), { once: true });
    const error = await connector.fetchChanges(request(["INBOX"])).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: "needs_reauth", userAction: "Konto erneut verbinden" });
    await expect(connector.fetchChanges(request(["INBOX"]))).resolves.toMatchObject({ complete: true });
    mailbox.setFailure(fixtureError("rate_limited"), { operations: ["applyMarker"] });
    await expect(connector.verify()).resolves.toMatchObject({ incrementalSync: "imap_uid" });
    await expect(
      connector.applyMarker({ strategy: "imap_flagged", keyword: null, folder: null, message: { providerMessageId: null, rfcMessageId: null, location: null } }, "set"),
    ).rejects.toMatchObject({ code: "rate_limited" });
    mailbox.setFailure(null);
  });

  it("Capabilities konfigurierbar; Marker werden aufgezeichnet und als Änderung gemeldet", async () => {
    const mailbox = new FixtureMailbox({ capabilities: { supportedMarkers: ["none", "imap_flagged"], customKeywords: false } });
    const message = await mailbox.addMessage("INBOX", eml("x"), { receivedAt: recent });
    const connector = new FixtureConnector(mailbox);
    expect(await connector.verify()).toMatchObject({ customKeywords: false, supportedMarkers: ["none", "imap_flagged"] });
    const first = await connector.fetchChanges(request(["INBOX"]));
    const target = { providerMessageId: message.providerMessageId, rfcMessageId: message.rfcMessageId, location: message.location };
    expect(await connector.applyMarker({ strategy: "imap_keyword", keyword: "$MailPilot", folder: null, message: target }, "set")).toMatchObject({ status: "unsupported" });
    expect(await connector.applyMarker({ strategy: "imap_flagged", keyword: null, folder: null, message: target }, "set")).toEqual({ status: "applied", detail: null });
    expect(await connector.applyMarker({ strategy: "imap_flagged", keyword: null, folder: null, message: target }, "set")).toEqual({ status: "applied", detail: "already_present" });
    expect(connector.markerOperations.map((op) => [op.request.strategy, op.operation, op.result.status])).toEqual([
      ["imap_keyword", "set", "unsupported"],
      ["imap_flagged", "set", "applied"],
      ["imap_flagged", "set", "applied"],
    ]);
    const next = await connector.fetchChanges(request(["INBOX"], first.cursors));
    expect(upserts(next).map((m) => m.location?.flags)).toEqual([["\\Flagged"]]);
    expect(upserts(next)[0]?.contentHash).toBe(message.contentHash);
  });

  it("Gmail-artige Fixture: gmail:-Schlüssel, Labels als Marker, UIDVALIDITY-Wechsel bei IMAP-Fixture", async () => {
    const gmail = new FixtureMailbox({ provider: "gmail", folders: [{ providerFolderId: "INBOX", role: "inbox" }] });
    const added = await gmail.addMessage("INBOX", eml("g"), { receivedAt: recent });
    expect(added).toMatchObject({ identityKey: expect.stringMatching(/^gmail:fx/), providerMessageId: expect.any(String), location: { uid: null, uidValidity: null } });
    const connector = new FixtureConnector(gmail);
    expect(connector.provider).toBe("gmail");
    const marker = { strategy: "gmail_label" as const, keyword: "MailPilot", folder: null, message: { providerMessageId: added.providerMessageId, rfcMessageId: null, location: null } };
    expect(await connector.applyMarker(marker, "set")).toEqual({ status: "applied", detail: null });
    expect(gmail.getMessage(added.identityKey)?.labels).toEqual(["MailPilot"]);

    const imap = new FixtureMailbox();
    await imap.addMessage("INBOX", eml("u"), { receivedAt: recent });
    const imapConnector = new FixtureConnector(imap);
    const first = await imapConnector.fetchChanges(request(["INBOX"]));
    imap.changeUidValidity("INBOX");
    const second = await imapConnector.fetchChanges(request(["INBOX"], first.cursors));
    expect(second.cursorResets).toEqual([{ providerFolderId: "INBOX", reason: "uidvalidity_changed" }]);
    expect(upserts(second).map((m) => m.location?.uidValidity)).toEqual([2n]);
  });

  it("entfernter Ordner: einmal folder_missing, danach Ruhe; neu angelegt → Neuimport", async () => {
    const mailbox = new FixtureMailbox({ folders: [{ providerFolderId: "INBOX" }, { providerFolderId: "Projekte" }] });
    await mailbox.addMessage("Projekte", eml("p1"), { receivedAt: recent });
    const connector = new FixtureConnector(mailbox);
    const first = await connector.fetchChanges(request(["INBOX", "Projekte"]));
    mailbox.removeFolder("Projekte");
    const gone = await connector.fetchChanges(request(["INBOX", "Projekte"], first.cursors));
    expect(gone.cursorResets).toEqual([{ providerFolderId: "Projekte", reason: "folder_missing" }]);
    const quiet = await connector.fetchChanges(request(["INBOX", "Projekte"], gone.cursors));
    expect([quiet.cursorResets, quiet.changes]).toEqual([[], []]);
    mailbox.addFolder({ providerFolderId: "Projekte" });
    await mailbox.addMessage("Projekte", eml("p2"), { receivedAt: recent });
    const back = await connector.fetchChanges(request(["INBOX", "Projekte"], quiet.cursors));
    expect(back.cursorResets).toEqual([{ providerFolderId: "Projekte", reason: "uidvalidity_changed" }]);
    expect(upserts(back).map((m) => m.identityKey)).toEqual(["rfc:p2@example.org"]);
  });
});

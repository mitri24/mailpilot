import type { FolderRole } from "@mailpilot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError, ImapConnector, createConnector, type FetchRequest, type FetchResult, type NormalizedMessage } from "../src/index.js";
import {
  RUN_ID,
  TEST_TLS,
  USERS,
  daysAgo,
  ensureFolders,
  eml,
  folderFlags,
  greenmailReachable,
  imapAccount,
  recordingClientFactory,
  resetMailbox,
  sendSmtp,
  withUserClient,
  IMAP_PORT,
} from "./helpers/greenmail.js";

const available = await greenmailReachable();
if (!available) {
  console.warn("GreenMail nicht erreichbar – IMAP-Integrationstests übersprungen (docker compose -f infra/docker-compose.yml --profile test up -d greenmail)");
}

function request(folders: Array<[string, FolderRole]>, cursors: Record<string, string> = {}, overrides: Partial<FetchRequest> = {}): FetchRequest {
  return {
    folders: folders.map(([providerFolderId, role]) => ({ providerFolderId, role, uidValidity: null })),
    cursors,
    since: daysAgo(14),
    maxMessages: 100,
    maxMessageBytes: 1_000_000,
    ownAddresses: [],
    ...overrides,
  };
}

function upserts(result: FetchResult): NormalizedMessage[] {
  return result.changes.flatMap((change) => (change.kind === "upsert" ? [change.message] : []));
}

const open: ImapConnector[] = [];
function connector(user: (typeof USERS)[keyof typeof USERS], commands?: string[]): ImapConnector {
  const instance = new ImapConnector(imapAccount(user), {
    tls: TEST_TLS,
    ...(commands ? { createClient: recordingClientFactory(commands) } : {}),
  });
  open.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((instance) => instance.close()));
});

describe.skipIf(!available)("IMAP-Connector gegen GreenMail", { timeout: 30_000 }, () => {
  it("importiert nur das Fenster, danach nur Neues – ohne \\Seen zu setzen (BODY.PEEK in EXAMINE)", async () => {
    const user = USERS.alice;
    await resetMailbox(user);
    await withUserClient(user, async (client) => {
      await client.append("INBOX", eml({ id: "old-1", subject: "Alt", date: daysAgo(30) }), [], daysAgo(30));
      await client.append("INBOX", eml({ id: "recent-1", subject: "Angebot prüfen", date: daysAgo(2) }), [], daysAgo(2));
      await client.append("INBOX", eml({ id: "recent-2", subject: "Termin" }), [], new Date());
    });
    const commands: string[] = [];
    const imap = connector(user, commands);

    const first = await imap.fetchChanges(request([["INBOX", "inbox"]]));
    expect(upserts(first).map((m) => m.identityKey).sort()).toEqual(["rfc:recent-1@example.org", "rfc:recent-2@example.org"]);
    expect(first.complete).toBe(true);
    expect(first.cursorResets).toEqual([]);
    expect(typeof first.uidValidity.INBOX).toBe("bigint");
    const offer = upserts(first).find((m) => m.identityKey === "rfc:recent-1@example.org");
    expect(offer).toMatchObject({
      rfcMessageId: "<recent-1@example.org>",
      subject: "Angebot prüfen",
      from: { name: "Max Muster", address: "max@example.org" },
      providerMessageId: null,
      webLink: null,
      truncated: false,
      location: { providerFolderId: "INBOX", uidValidity: first.uidValidity.INBOX, flags: [] },
    });
    expect(offer?.bodyText).toContain("bis Freitag das Angebot recent-1 prüfen");
    expect(offer?.location?.uid).toBeTypeOf("bigint");

    await withUserClient(user, (client) => client.append("INBOX", eml({ id: "recent-3", subject: "Neu" }), [], new Date()));
    const second = await imap.fetchChanges(request([["INBOX", "inbox"]], first.cursors));
    expect(second.changes.map((c) => c.kind)).toEqual(["upsert"]);
    expect(upserts(second)[0]?.identityKey).toBe("rfc:recent-3@example.org");

    const third = await imap.fetchChanges(request([["INBOX", "inbox"]], second.cursors));
    expect(third.changes).toEqual([]);
    expect(third.complete).toBe(true);

    const flags = await folderFlags(user, "INBOX");
    expect(flags).toHaveLength(4);
    expect(flags.flatMap((row) => row.flags)).not.toContain("\\Seen");

    // Wire evidence: read-only EXAMINE, BODY.PEEK only, and nothing that changes the mailbox.
    expect(commands.some((c) => /^\S+ EXAMINE /.test(c))).toBe(true);
    expect(commands.some((c) => /^\S+ UID FETCH .*BODY\.PEEK\[\]/.test(c))).toBe(true);
    expect(commands.filter((c) => /BODY\[/.test(c) && !/BODY\.PEEK\[/.test(c))).toEqual([]);
    expect(commands.filter((c) => /^\S+ (UID )?(SELECT|STORE|COPY|MOVE|EXPUNGE|CLOSE|APPEND)\b/.test(c))).toEqual([]);
  });

  it("teilt den Erstimport nach maxMessages auf und setzt mit dem Cursor fort", async () => {
    const user = USERS.alice;
    await resetMailbox(user);
    await withUserClient(user, async (client) => {
      for (let i = 1; i <= 5; i++) await client.append("INBOX", eml({ id: `page-${i}`, subject: `Seite ${i}` }), [], daysAgo(1));
    });
    const imap = connector(user);
    const seen: string[] = [];
    let cursors: Record<string, string> = {};
    const completes: boolean[] = [];
    for (let round = 0; round < 3; round++) {
      const result = await imap.fetchChanges(request([["INBOX", "inbox"]], cursors, { maxMessages: 2 }));
      seen.push(...upserts(result).map((m) => m.identityKey));
      completes.push(result.complete);
      cursors = result.cursors;
    }
    expect(completes).toEqual([false, false, true]);
    expect(seen).toEqual([1, 2, 3, 4, 5].map((i) => `rfc:page-${i}@example.org`));
  });

  it("meldet Verschieben (MOVE) als location_removed + upsert mit gleicher identityKey und erkennt Expunge", async () => {
    const user = USERS.bob;
    await resetMailbox(user);
    await withUserClient(user, async (client) => {
      await ensureFolders(client, ["Archive"]);
      await client.append("INBOX", eml({ id: "move-1", subject: "Wird archiviert" }), [], new Date());
      await client.append("INBOX", eml({ id: "del-1", subject: "Wird gelöscht" }), [], new Date());
    });
    const imap = connector(user);
    const folders: Array<[string, FolderRole]> = [
      ["INBOX", "inbox"],
      ["Archive", "archive"],
    ];
    const first = await imap.fetchChanges(request(folders));
    const byKey = new Map(upserts(first).map((m) => [m.identityKey, m]));
    const moved = byKey.get("rfc:move-1@example.org");
    const removed = byKey.get("rfc:del-1@example.org");
    expect(moved?.location?.providerFolderId).toBe("INBOX");
    expect(removed).toBeDefined();

    await withUserClient(user, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageMove(String(moved?.location?.uid), "Archive", { uid: true });
        await client.messageDelete(String(removed?.location?.uid), { uid: true });
      } finally {
        lock.release();
      }
    });

    const second = await imap.fetchChanges(request(folders, first.cursors));
    const removedLocations = second.changes.flatMap((c) => (c.kind === "location_removed" ? [c.location] : []));
    expect(removedLocations).toEqual(
      expect.arrayContaining([
        { providerFolderId: "INBOX", uidValidity: first.uidValidity.INBOX, uid: moved?.location?.uid, flags: [] },
        { providerFolderId: "INBOX", uidValidity: first.uidValidity.INBOX, uid: removed?.location?.uid, flags: [] },
      ]),
    );
    expect(removedLocations).toHaveLength(2);
    const arrived = upserts(second);
    expect(arrived.map((m) => [m.identityKey, m.location?.providerFolderId])).toEqual([["rfc:move-1@example.org", "Archive"]]);
    expect(arrived[0]?.contentHash).toBe(moved?.contentHash);
  });

  it("setzt und entfernt Marker: Schlagwort, \\Flagged und Kopie in Ordner", async () => {
    const user = USERS.carol;
    await resetMailbox(user);
    await withUserClient(user, (client) => client.append("INBOX", eml({ id: "mark-1", subject: "Markieren" }), [], new Date()));
    const imap = connector(user);
    const capabilities = await imap.verify();
    expect(capabilities).toMatchObject({ incrementalSync: "imap_uid", customKeywords: true, flagged: true, webLinks: false });
    expect(capabilities.supportedMarkers).toEqual(["none", "imap_keyword", "imap_flagged", "imap_copy_folder"]);
    expect(capabilities.notes.join(" ")).toContain("Apple Mail zeigt sie aber nicht an");

    const [message] = upserts(await imap.fetchChanges(request([["INBOX", "inbox"]])));
    expect(message).toBeDefined();
    const target = { providerMessageId: message?.providerMessageId ?? null, rfcMessageId: message?.rfcMessageId ?? null, location: message?.location ?? null };

    const keyword = { strategy: "imap_keyword" as const, keyword: "$MailPilot", folder: null, message: target };
    expect(await imap.applyMarker(keyword, "set")).toEqual({ status: "applied", detail: null });
    expect(await imap.applyMarker(keyword, "set")).toEqual({ status: "applied", detail: "already_present" });
    expect((await folderFlags(user, "INBOX"))[0]?.flags).toEqual(["$MailPilot"]);
    expect(await imap.applyMarker(keyword, "clear")).toEqual({ status: "applied", detail: null });
    expect((await folderFlags(user, "INBOX"))[0]?.flags).toEqual([]);

    const flagged = { strategy: "imap_flagged" as const, keyword: null, folder: null, message: target };
    expect(await imap.applyMarker(flagged, "set")).toEqual({ status: "applied", detail: null });
    expect((await folderFlags(user, "INBOX"))[0]?.flags).toEqual(["\\Flagged"]);
    expect(await imap.applyMarker(flagged, "clear")).toEqual({ status: "applied", detail: null });
    expect((await folderFlags(user, "INBOX"))[0]?.flags).toEqual([]);

    const copy = { strategy: "imap_copy_folder" as const, keyword: null, folder: "MailPilot", message: target };
    expect(await imap.applyMarker(copy, "set")).toEqual({ status: "applied", detail: null });
    expect(await imap.applyMarker(copy, "set")).toEqual({ status: "applied", detail: "already_present" });
    const copies = await folderFlags(user, "MailPilot");
    expect(copies).toEqual([{ uid: expect.any(Number), messageId: "<mark-1@example.org>", flags: ["$MailPilotCopy"] }]);
    // A message the user filed there with the same Message-ID must survive "clear".
    await withUserClient(user, (client) => client.append("MailPilot", eml({ id: "mark-1", subject: "Markieren" }), [], new Date()));
    expect(await imap.applyMarker(copy, "clear")).toEqual({ status: "applied", detail: null });
    expect((await folderFlags(user, "MailPilot")).map((row) => row.flags)).toEqual([[]]);
    const inbox = await folderFlags(user, "INBOX");
    expect(inbox).toHaveLength(1);
    expect(inbox.flatMap((row) => row.flags)).not.toContain("\\Seen");
  });

  it("erkennt einen UIDVALIDITY-Wechsel (Ordner neu angelegt) und importiert das Fenster neu", async () => {
    const user = USERS.dave;
    const folder = `Projekte-${RUN_ID}`;
    await resetMailbox(user);
    await withUserClient(user, async (client) => {
      await client.mailboxCreate(folder);
      await client.append(folder, eml({ id: "proj-1", subject: "Projekt alt" }), [], new Date());
    });
    const imap = connector(user);
    const first = await imap.fetchChanges(request([[folder, "other"]]));
    const before = upserts(first)[0];
    expect(before?.identityKey).toBe("rfc:proj-1@example.org");

    // GreenMail derives UIDVALIDITY from the creation second, so wait before recreating.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await withUserClient(user, async (client) => {
      await client.mailboxDelete(folder);
      await client.mailboxCreate(folder);
      await client.append(folder, eml({ id: "proj-2", subject: "Projekt neu" }), [], new Date());
      await client.append(folder, eml({ id: "proj-old", subject: "Zu alt", date: daysAgo(40) }), [], daysAgo(40));
    });
    const second = await imap.fetchChanges(request([[folder, "other"]], first.cursors));
    expect(second.cursorResets).toEqual([{ providerFolderId: folder, reason: "uidvalidity_changed" }]);
    expect(second.uidValidity[folder]).not.toBe(first.uidValidity[folder]);
    expect(second.changes).toContainEqual({
      kind: "location_removed",
      identityKey: null,
      location: { providerFolderId: folder, uidValidity: first.uidValidity[folder], uid: before?.location?.uid, flags: [] },
    });
    expect(upserts(second).map((m) => [m.identityKey, m.location?.uidValidity])).toEqual([["rfc:proj-2@example.org", second.uidValidity[folder]]]);
  });

  it("liefert Ordnerrollen, liest per SMTP zugestellte Mails und meldet verschwundene Ordner", async () => {
    const user = USERS.erin;
    const customers = `Kunden-${RUN_ID}`;
    await resetMailbox(user);
    await withUserClient(user, (client) => ensureFolders(client, ["Sent", "Archive", "Junk", "Drafts", "Deleted Messages", customers]));
    const imap = connector(user);
    const folders = await imap.listFolders();
    const roles = Object.fromEntries(folders.map((folder) => [folder.path, folder.role]));
    expect(roles).toMatchObject({
      INBOX: "inbox",
      Sent: "sent",
      Archive: "archive",
      Junk: "spam",
      Drafts: "drafts",
      "Deleted Messages": "trash",
      [customers]: "other",
    });
    expect(folders.every((folder) => typeof folder.uidValidity === "bigint")).toBe(true);

    await sendSmtp("max@example.org", user.user, eml({ id: "smtp-1", subject: "Per SMTP", to: user.user }));
    await withUserClient(user, (client) => client.append(customers, eml({ id: "kunde-1", subject: "Kunde" }), [], new Date()));
    const first = await imap.fetchChanges(request([["INBOX", "inbox"], [customers, "other"]]));
    expect(upserts(first).map((m) => m.identityKey).sort()).toEqual(["rfc:kunde-1@example.org", "rfc:smtp-1@example.org"]);

    await withUserClient(user, (client) => client.mailboxDelete(customers));
    const second = await imap.fetchChanges(request([["INBOX", "inbox"], [customers, "other"]], first.cursors));
    expect(second.cursorResets).toEqual([{ providerFolderId: customers, reason: "folder_missing" }]);
    expect(second.changes).toEqual([
      { kind: "location_removed", identityKey: null, location: expect.objectContaining({ providerFolderId: customers }) },
    ]);
    // The folder stays selected but missing: no repeated removals or resets.
    const third = await imap.fetchChanges(request([["INBOX", "inbox"], [customers, "other"]], second.cursors));
    expect([third.changes, third.cursorResets]).toEqual([[], []]);
    // Recreated folder: clean re-import of the window.
    await withUserClient(user, async (client) => {
      await client.mailboxCreate(customers);
      await client.append(customers, eml({ id: "kunde-2", subject: "Kunde neu" }), [], new Date());
    });
    const fourth = await imap.fetchChanges(request([["INBOX", "inbox"], [customers, "other"]], third.cursors));
    expect(fourth.cursorResets).toEqual([{ providerFolderId: customers, reason: "uidvalidity_changed" }]);
    expect(upserts(fourth).map((m) => m.identityKey)).toEqual(["rfc:kunde-2@example.org"]);
    expect(fourth.changes.filter((c) => c.kind === "location_removed")).toEqual([]);
  });

  it("createConnector reicht imapTls an den IMAP-Connector durch", async () => {
    const imap = createConnector(imapAccount(USERS.frank), { imapTls: TEST_TLS });
    try {
      expect(imap.provider).toBe("imap");
      expect((await imap.verify()).incrementalSync).toBe("imap_uid");
      expect((await imap.listFolders()).map((folder) => folder.role)).toContain("inbox");
    } finally {
      await imap.close();
    }
    const tokens = { getAccessToken: async () => "unused", invalidate: () => undefined };
    expect(createConnector({ provider: "gmail", emailAddress: "anna@example.com", tokens }).provider).toBe("gmail");
    expect(createConnector({ provider: "microsoft", emailAddress: "anna@example.com", tokens }).provider).toBe("microsoft");
  });

  it("verbindet nie im Klartext und bildet Anmelde- und TLS-Fehler ab", async () => {
    const user = USERS.frank;
    // GreenMail offers no STARTTLS on 3143: the connection must fail before LOGIN.
    const commands: string[] = [];
    const plain = new ImapConnector(imapAccount(user, { port: IMAP_PORT, secure: false }), {
      tls: TEST_TLS,
      createClient: recordingClientFactory(commands),
    });
    open.push(plain);
    const tlsError = await plain.verify().catch((err: unknown) => err);
    expect(tlsError).toBeInstanceOf(ConnectorError);
    expect(tlsError).toMatchObject({ code: "tls", userAction: "Sichere Verbindung fehlgeschlagen – Server, Port und Verschlüsselung prüfen" });
    expect(commands.some((c) => /LOGIN|AUTHENTICATE/.test(c))).toBe(false);

    const wrongPassword = new ImapConnector(imapAccount({ user: user.user, pass: "falsch" }), { tls: TEST_TLS });
    open.push(wrongPassword);
    await expect(wrongPassword.verify()).rejects.toMatchObject({ code: "auth_failed", userAction: "Zugangsdaten oder App-Passwort prüfen" });

    // Without the injected test TLS options the self-signed certificate is rejected.
    const strict = new ImapConnector(imapAccount(user));
    open.push(strict);
    await expect(strict.verify()).rejects.toMatchObject({ code: "tls" });

    const closedPort = new ImapConnector(imapAccount(user, { port: 3999 }), { tls: TEST_TLS });
    open.push(closedPort);
    await expect(closedPort.verify()).rejects.toMatchObject({ code: "network" });
  });
});

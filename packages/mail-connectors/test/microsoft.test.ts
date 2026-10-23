import { describe, expect, it } from "vitest";
import { ConnectorError, MicrosoftConnector, type FetchRequest, type FetchResult, type NormalizedMessage } from "../src/index.js";
import { fakeTokens, json, mockFetch, type RecordedRequest } from "./helpers/http.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const INBOX = "AAMkAGI2-inbox";
const SINCE = new Date("2026-10-09T00:00:00Z");

function graphMessage(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@odata.type": "#microsoft.graph.message",
    "@odata.etag": `W/"CQAAABYAAAARn2vdzPFjSbaPPxzjlzOT-${id}"`,
    id,
    receivedDateTime: "2026-10-22T08:15:00Z",
    sentDateTime: "2026-10-22T08:14:58Z",
    hasAttachments: false,
    internetMessageId: `<${id}@example.org>`,
    subject: `Betreff ${id}`,
    body: { contentType: "html", content: `<html><body><p>Hallo Anna, bitte <b>${id}</b> prüfen.</p></body></html>` },
    conversationId: `AAQkAGI2-conv-${id}`,
    webLink: `https://outlook.office365.com/owa/?ItemID=${id}&exvsurl=1&viewmodel=ReadMessageItem`,
    from: { emailAddress: { name: "Max Muster", address: "Max@Example.org" } },
    sender: { emailAddress: { name: "Max Muster", address: "max@example.org" } },
    toRecipients: [{ emailAddress: { name: "Anna Beispiel", address: "anna@example.com" } }],
    ccRecipients: [],
    categories: [],
    flag: { flagStatus: "notFlagged" },
    isRead: false,
    parentFolderId: INBOX,
    ...overrides,
  };
}

interface GraphState {
  messages: Record<string, Record<string, unknown>>;
  deltaPages: Record<string, Record<string, unknown>>;
  deltaStatus?: { status: number; body: unknown; headers?: Record<string, string> };
  /** One-shot failures, consumed by the next delta requests. */
  deltaFailures?: Array<{ status: number; body: unknown }>;
}

function graphApi(state: GraphState): (request: RecordedRequest) => Response {
  return (request) => {
    // nextLink/deltaLink use OData key syntax (mailFolders('id')) like the documentation samples.
    const path = decodeURIComponent(request.url.pathname.replace("/v1.0", "")).replace(/mailFolders\('([^']+)'\)/, "mailFolders/$1");
    const params = request.url.searchParams;
    const wellKnown: Record<string, string> = { inbox: INBOX, sentitems: "AAMk-sent", deleteditems: "AAMk-trash", junkemail: "AAMk-junk", drafts: "AAMk-drafts" };
    const known = /^\/me\/mailFolders\/(inbox|sentitems|deleteditems|junkemail|archive|drafts)$/.exec(path);
    if (known) {
      const id = wellKnown[known[1] as string];
      return id ? json(200, { id }) : json(404, { error: { code: "ErrorFolderNotFound", message: "The specified folder could not be found in the store." } });
    }
    if (path === "/me/mailFolders") {
      return json(200, {
        value: [
          { id: INBOX, displayName: "Posteingang", parentFolderId: "root", childFolderCount: 1, unreadItemCount: 1, totalItemCount: 3, isHidden: false },
          { id: "AAMk-sent", displayName: "Gesendete Elemente", parentFolderId: "root", childFolderCount: 0, isHidden: false },
          { id: "AAMk-trash", displayName: "Gelöschte Elemente", parentFolderId: "root", childFolderCount: 0, isHidden: false },
          { "@odata.type": "#microsoft.graph.mailSearchFolder", id: "AAMk-search", displayName: "Wochenberichte", parentFolderId: INBOX, childFolderCount: 0 },
        ],
      });
    }
    if (path === `/me/mailFolders/${INBOX}/childFolders`) {
      return json(200, { value: [{ id: "AAMk-kunden", displayName: "Kunden", parentFolderId: INBOX, childFolderCount: 0, isHidden: false }] });
    }
    if (path === `/me/mailFolders/${INBOX}/messages/delta`) {
      if (state.deltaStatus) return json(state.deltaStatus.status, state.deltaStatus.body, state.deltaStatus.headers);
      const failure = state.deltaFailures?.shift();
      if (failure) return json(failure.status, failure.body);
      const key = params.get("$deltatoken") ?? params.get("$skiptoken") ?? "initial";
      const page = state.deltaPages[key];
      return page ? json(200, page) : json(500, { error: { code: "generalException", message: `no page ${key}` } });
    }
    const attachments = /^\/me\/messages\/([^/]+)\/attachments$/.exec(path);
    if (attachments) {
      return json(200, {
        value: [
          { "@odata.type": "#microsoft.graph.fileAttachment", id: "att-1", name: "angebot.pdf", contentType: "application/pdf", size: 48213, isInline: false },
          { "@odata.type": "#microsoft.graph.fileAttachment", id: "att-2", name: "logo.png", contentType: "image/png", size: 2048, isInline: true },
        ],
      });
    }
    const single = /^\/me\/messages\/([^/]+)$/.exec(path);
    if (single) {
      const id = decodeURIComponent(single[1] as string);
      const stored = state.messages[id];
      if (!stored) return json(404, { error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } });
      if (request.method === "PATCH") {
        Object.assign(stored, JSON.parse(request.body ?? "{}"));
        return json(200, stored);
      }
      return json(200, stored);
    }
    return json(500, { error: { code: "generalException", message: `unexpected ${request.method} ${path}` } });
  };
}

function setup(state: GraphState, tokens = fakeTokens()) {
  const http = mockFetch(graphApi(state));
  const connector = new MicrosoftConnector({ provider: "microsoft", emailAddress: "anna@example.com", tokens: tokens.source }, { fetch: http.fetch });
  return { connector, requests: http.requests, tokens };
}

function request(cursors: Record<string, string> = {}, maxMessages = 50): FetchRequest {
  return {
    folders: [{ providerFolderId: INBOX, role: "inbox", uidValidity: null }],
    cursors,
    since: SINCE,
    maxMessages,
    maxMessageBytes: 200_000,
    ownAddresses: ["anna@example.com"],
  };
}

const upserts = (result: FetchResult): NormalizedMessage[] => result.changes.flatMap((c) => (c.kind === "upsert" ? [c.message] : []));
const deltaUrl = (token: string, kind: "skiptoken" | "deltatoken") => `${GRAPH}/me/mailFolders('${INBOX}')/messages/delta?$${kind}=${token}`;

function initialState(): GraphState {
  const m1 = graphMessage("msg-1", {
    hasAttachments: true,
    body: { contentType: "html", content: '<p>Angebot anbei <img src="https://tracker.example.com/p.gif" width="1" height="1"></p>' },
    isRead: true,
    flag: { flagStatus: "flagged" },
    categories: ["Rot"],
  });
  const m2 = graphMessage("msg-2", { body: { contentType: "text", content: "Nur Text, bitte bis Montag." } });
  return {
    messages: { "msg-1": m1, "msg-2": m2 },
    deltaPages: {
      initial: { "@odata.context": `${GRAPH}/$metadata#Collection(message)`, "@odata.nextLink": deltaUrl("page-2", "skiptoken"), value: [m1] },
      "page-2": { "@odata.context": `${GRAPH}/$metadata#Collection(message)`, "@odata.deltaLink": deltaUrl("round-1", "deltatoken"), value: [m2] },
    },
  };
}

describe("Microsoft-Graph-Connector (gemocktes fetch)", () => {
  it("Erstabgleich per Ordner-Delta mit $filter, ImmutableId-Header und deltaLink als Cursor", async () => {
    const { connector, requests } = setup(initialState());
    const result = await connector.fetchChanges(request());
    const [first, second] = requests.filter((r) => r.url.pathname.endsWith("/messages/delta"));
    expect(first?.url.pathname).toBe(`/v1.0/me/mailFolders/${INBOX}/messages/delta`);
    expect(first?.url.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-10-09T00:00:00Z");
    expect(first?.url.searchParams.get("$select")?.split(",")).toEqual(
      expect.arrayContaining(["body", "internetMessageId", "conversationId", "webLink", "hasAttachments", "toRecipients", "ccRecipients", "from"]),
    );
    expect(first?.headers.get("prefer")).toBe('IdType="ImmutableId", odata.maxpagesize=50');
    expect(second?.url.toString()).toBe(deltaUrl("page-2", "skiptoken"));
    expect(requests.every((r) => r.headers.get("prefer")?.includes('IdType="ImmutableId"'))).toBe(true);
    const attachmentCalls = requests.filter((r) => r.url.pathname.endsWith("/attachments"));
    expect(attachmentCalls.map((r) => r.url.searchParams.get("$select"))).toEqual(["name,contentType,size,isInline"]);

    const [m1, m2] = upserts(result);
    expect(m1).toMatchObject({
      identityKey: "graph:msg-1",
      providerMessageId: "msg-1",
      providerThreadId: "AAQkAGI2-conv-msg-1",
      rfcMessageId: "<msg-1@example.org>",
      from: { name: "Max Muster", address: "max@example.org" },
      to: [{ name: "Anna Beispiel", address: "anna@example.com" }],
      bodyText: "Angebot anbei",
      bodyHtmlSanitized: "<p>Angebot anbei </p>",
      remoteContentBlocked: 1,
      attachments: [
        { filename: "angebot.pdf", contentType: "application/pdf", size: 48213, inline: false },
        { filename: "logo.png", contentType: "image/png", size: 2048, inline: true },
      ],
      webLink: "https://outlook.office365.com/owa/?ItemID=msg-1&exvsurl=1&viewmodel=ReadMessageItem",
      labels: ["Rot"],
      location: { providerFolderId: INBOX, uidValidity: null, uid: null, flags: ["\\Flagged", "\\Seen"] },
      sizeBytes: null,
      truncated: false,
    });
    expect(m1?.receivedAt?.toISOString()).toBe("2026-10-22T08:15:00.000Z");
    expect(m2).toMatchObject({ identityKey: "graph:msg-2", bodyText: "Nur Text, bitte bis Montag.", bodyHtmlSanitized: null, attachments: [], location: { flags: [] } });
    expect(result.complete).toBe(true);
    expect(JSON.parse(result.cursors[`microsoft:${INBOX}`] ?? "{}")).toEqual({ v: 1, url: deltaUrl("round-1", "deltatoken"), paging: false });
  });

  it("Folgerunde: @removed wird zu location_removed (verschoben) oder deleted (gelöscht), Teil-Updates werden nachgeladen", async () => {
    const state = initialState();
    const { connector, requests } = setup(state);
    const initial = await connector.fetchChanges(request());
    requests.length = 0;
    state.messages["msg-2"] = { ...(state.messages["msg-2"] as Record<string, unknown>), parentFolderId: "AAMk-archive" };
    delete state.messages["msg-1"];
    state.messages["msg-3"] = graphMessage("msg-3", { isRead: true });
    state.deltaPages["round-1"] = {
      "@odata.deltaLink": deltaUrl("round-2", "deltatoken"),
      value: [
        { "@odata.type": "#microsoft.graph.message", id: "msg-1", "@removed": { reason: "deleted" } },
        { "@odata.type": "#microsoft.graph.message", id: "msg-2", "@removed": { reason: "deleted" } },
        { "@odata.type": "#microsoft.graph.message", "@odata.etag": 'W/"x"', id: "msg-3", isRead: "true" },
      ],
    };
    const result = await connector.fetchChanges(request(initial.cursors));
    expect(requests[0]?.url.toString()).toBe(deltaUrl("round-1", "deltatoken"));
    expect(result.changes).toEqual([
      { kind: "deleted", identityKey: "graph:msg-1" },
      { kind: "location_removed", identityKey: "graph:msg-2", location: { providerFolderId: INBOX, uidValidity: null, uid: null, flags: [] } },
      expect.objectContaining({ kind: "upsert", message: expect.objectContaining({ identityKey: "graph:msg-3", subject: "Betreff msg-3" }) }),
    ]);
    const lookups = requests.filter((r) => /\/me\/messages\/[^/]+$/.test(r.url.pathname)).map((r) => [r.url.pathname.split("/").pop(), r.url.searchParams.get("$select")?.split(",")[0]]);
    expect(lookups).toEqual([
      ["msg-1", "id"],
      ["msg-2", "id"],
      ["msg-3", "id"],
    ]);
  });

  it("abgelaufener Delta-Token (410 Gone oder syncStateNotFound) startet neu im Importfenster", async () => {
    for (const failure of [
      { status: 410, body: { error: { code: "resyncRequired", message: "Resync required." } } },
      { status: 400, body: { error: { code: "SyncStateNotFound", message: "The sync state could not be found." } } },
    ]) {
      const state = initialState();
      const { connector, requests } = setup(state);
      const initial = await connector.fetchChanges(request());
      requests.length = 0;
      // The stale deltaLink fails once; the restarted round succeeds.
      state.deltaFailures = [failure];
      const result = await connector.fetchChanges(request(initial.cursors));
      expect(result.cursorResets).toEqual([{ providerFolderId: INBOX, reason: "delta_token_expired" }]);
      const deltaCalls = requests.filter((r) => r.url.pathname.endsWith("/messages/delta"));
      expect(deltaCalls[0]?.url.searchParams.get("$deltatoken")).toBe("round-1");
      expect(deltaCalls[1]?.url.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-10-09T00:00:00Z");
      expect(upserts(result).map((m) => m.identityKey)).toEqual(["graph:msg-1", "graph:msg-2"]);
    }
  });

  it("429 mit Retry-After → rate_limited; 401 → Refresh-Versuch → needs_reauth", async () => {
    const state429 = initialState();
    state429.deltaStatus = {
      status: 429,
      headers: { "Retry-After": "10" },
      body: { error: { code: "TooManyRequests", innerError: { code: "429", date: "2026-10-22T12:51:51", message: "Please retry after", "request-id": "94fb3b52-452a-4535-a601-69e0a90e3aa2", status: "429" }, message: "Please retry again later." } },
    };
    const limited = setup(state429);
    await expect(limited.connector.fetchChanges(request())).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 10, userAction: "Kurz warten – MailPilot versucht es automatisch erneut" });

    const tokens = fakeTokens();
    const http = mockFetch(() => json(401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } }));
    const connector = new MicrosoftConnector({ provider: "microsoft", emailAddress: "anna@example.com", tokens: tokens.source }, { fetch: http.fetch });
    const error = await connector.verify().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: "needs_reauth", userAction: "Konto erneut verbinden" });
    expect(tokens.stats.invalidations).toBe(1);
    expect(http.requests.map((r) => r.headers.get("authorization"))).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("folgt nur Links auf graph.microsoft.com (manipulierter Cursor oder nextLink)", async () => {
    const state = initialState();
    const { connector, requests } = setup(state);
    const tampered = JSON.stringify({ v: 1, url: "https://evil.example.com/steal?$deltatoken=x", paging: false });
    const result = await connector.fetchChanges(request({ [`microsoft:${INBOX}`]: tampered }));
    expect(result.cursorResets).toEqual([{ providerFolderId: INBOX, reason: "cursor_invalid" }]);
    expect(requests.every((r) => r.url.hostname === "graph.microsoft.com")).toBe(true);

    state.deltaPages.initial = { "@odata.nextLink": "https://evil.example.com/next", value: [] };
    await expect(connector.fetchChanges(request())).rejects.toMatchObject({ code: "server" });
    expect(requests.every((r) => r.url.hostname === "graph.microsoft.com")).toBe(true);
  });

  it("begrenzt Seiten auf maxMessages und setzt mit dem nextLink fort", async () => {
    const { connector, requests } = setup(initialState());
    const first = await connector.fetchChanges(request({}, 1));
    expect(requests[0]?.headers.get("prefer")).toBe('IdType="ImmutableId", odata.maxpagesize=1');
    expect([upserts(first).map((m) => m.identityKey), first.complete]).toEqual([["graph:msg-1"], false]);
    expect(JSON.parse(first.cursors[`microsoft:${INBOX}`] ?? "{}")).toMatchObject({ url: deltaUrl("page-2", "skiptoken"), paging: true });
    const second = await connector.fetchChanges(request(first.cursors, 1));
    expect([upserts(second).map((m) => m.identityKey), second.complete]).toEqual([["graph:msg-2"], true]);
  });

  it("listFolders: Rollen über Well-known-Namen, Unterordner mit Pfad, ohne Suchordner", async () => {
    const { connector } = setup(initialState());
    const folders = await connector.listFolders();
    expect(folders.map((f) => [f.providerFolderId, f.path, f.role])).toEqual([
      [INBOX, "Posteingang", "inbox"],
      ["AAMk-kunden", "Posteingang/Kunden", "other"],
      ["AAMk-sent", "Gesendete Elemente", "sent"],
      ["AAMk-trash", "Gelöschte Elemente", "trash"],
    ]);
  });

  it("Marker: Kategorie und Kennzeichnung per PATCH, already_present ohne Schreibzugriff", async () => {
    const state = initialState();
    const { connector, requests } = setup(state);
    const message = { providerMessageId: "msg-2", rfcMessageId: "<msg-2@example.org>", location: null };
    const category = { strategy: "graph_category" as const, keyword: null, folder: null, message };
    expect(await connector.applyMarker(category, "set")).toEqual({ status: "applied", detail: null });
    expect(state.messages["msg-2"]?.categories).toEqual(["MailPilot"]);
    expect(await connector.applyMarker(category, "set")).toEqual({ status: "applied", detail: "already_present" });
    expect(await connector.applyMarker(category, "clear")).toEqual({ status: "applied", detail: null });
    expect(state.messages["msg-2"]?.categories).toEqual([]);

    const flag = { strategy: "graph_flag" as const, keyword: null, folder: null, message };
    expect(await connector.applyMarker(flag, "set")).toEqual({ status: "applied", detail: null });
    expect(state.messages["msg-2"]?.flag).toEqual({ flagStatus: "flagged" });
    expect(await connector.applyMarker(flag, "clear")).toEqual({ status: "applied", detail: null });
    expect(state.messages["msg-2"]?.flag).toEqual({ flagStatus: "notFlagged" });
    expect(await connector.applyMarker({ ...flag, message: { ...message, providerMessageId: "missing" } }, "set")).toMatchObject({ status: "failed" });
    expect(await connector.applyMarker({ ...flag, strategy: "imap_keyword" }, "set")).toMatchObject({ status: "unsupported" });
    const patches = requests.filter((r) => r.method === "PATCH").map((r) => JSON.parse(r.body ?? "{}"));
    expect(patches).toEqual([{ categories: ["MailPilot"] }, { categories: [] }, { flag: { flagStatus: "flagged" } }, { flag: { flagStatus: "notFlagged" } }]);
  });

  it("fehlende Schreibrechte (403) werden als permission_denied gemeldet", async () => {
    const state = initialState();
    const api = graphApi(state);
    const http = mockFetch((r) => (r.method === "PATCH" ? json(403, { error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } }) : api(r)));
    const connector = new MicrosoftConnector({ provider: "microsoft", emailAddress: "anna@example.com", tokens: fakeTokens().source }, { fetch: http.fetch });
    const marker = { strategy: "graph_flag" as const, keyword: null, folder: null, message: { providerMessageId: "msg-2", rfcMessageId: null, location: null } };
    await expect(connector.applyMarker(marker, "set")).rejects.toMatchObject({ code: "permission_denied", userAction: "Berechtigungen prüfen und Konto erneut verbinden" });
    const capabilities = await connector.verify();
    expect(capabilities).toMatchObject({ incrementalSync: "graph_delta", categories: true, flagged: true, immutableIds: true, supportedMarkers: ["none", "graph_category", "graph_flag"] });
  });

  it("gelöschter Ordner (404): einmal folder_missing, danach ein Platzhalter-Cursor ohne Wiederholung", async () => {
    const state = initialState();
    const { connector } = setup(state);
    const initial = await connector.fetchChanges(request());
    state.deltaStatus = { status: 404, body: { error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } } };
    const gone = await connector.fetchChanges(request(initial.cursors));
    expect(gone.cursorResets).toEqual([{ providerFolderId: INBOX, reason: "folder_missing" }]);
    expect(JSON.parse(gone.cursors[`microsoft:${INBOX}`] ?? "{}")).toMatchObject({ missing: true, paging: false });
    const again = await connector.fetchChanges(request(gone.cursors));
    expect([again.cursorResets, again.changes]).toEqual([[], []]);
  });
});

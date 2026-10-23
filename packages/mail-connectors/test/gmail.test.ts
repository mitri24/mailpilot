import { describe, expect, it } from "vitest";
import { ConnectorError, GmailConnector, type FetchRequest, type FetchResult, type NormalizedMessage } from "../src/index.js";
import { base64Url, eml, fakeTokens, json, mockFetch, type RecordedRequest } from "./helpers/http.js";

interface StoredMessage {
  threadId: string;
  labelIds: string[];
  internalDate: string;
  raw: string;
}

interface GmailState {
  historyId: string;
  messages: Record<string, StoredMessage>;
  history: Array<{ id: string; [key: string]: unknown }>;
  historyStatus?: number;
  /** Labels whose messages.list answers 400 "Invalid label" (deleted in Gmail). */
  deletedLabels?: string[];
  labels: Array<{ id: string; name: string; type: "system" | "user" }>;
}

const SINCE = new Date("2026-10-09T00:00:00Z");

function message(id: string, labelIds: string[], subject = `Betreff ${id}`): StoredMessage {
  return { threadId: `t-${id}`, labelIds, internalDate: String(Date.parse("2026-10-22T08:15:00Z")), raw: base64Url(eml(id, subject)) };
}

function notFound(): Response {
  return json(404, {
    error: {
      code: 404,
      message: "Requested entity was not found.",
      errors: [{ message: "Requested entity was not found.", domain: "global", reason: "notFound" }],
      status: "NOT_FOUND",
    },
  });
}

function gmailApi(state: GmailState): (request: RecordedRequest) => Response {
  return (request) => {
    const path = request.url.pathname.replace("/gmail/v1/users/me", "");
    const query = request.url.searchParams;
    if (path === "/profile") {
      return json(200, { emailAddress: "anna@example.com", messagesTotal: 4, threadsTotal: 4, historyId: state.historyId });
    }
    if (path === "/messages" && request.method === "GET") {
      const label = query.get("labelIds") ?? "";
      if (state.deletedLabels?.includes(label)) {
        return json(400, { error: { code: 400, message: `Invalid label: ${label}`, errors: [{ message: `Invalid label: ${label}`, domain: "global", reason: "invalidArgument" }], status: "INVALID_ARGUMENT" } });
      }
      const includeSpamTrash = query.get("includeSpamTrash") === "true";
      const ids = Object.entries(state.messages)
        .filter(([, m]) => m.labelIds.includes(label))
        .filter(([, m]) => includeSpamTrash || !m.labelIds.some((l) => l === "SPAM" || l === "TRASH"))
        .map(([id, m]) => ({ id, threadId: m.threadId }));
      return json(200, { messages: ids, resultSizeEstimate: ids.length });
    }
    const modify = /^\/messages\/([^/]+)\/modify$/.exec(path);
    if (modify && request.method === "POST") {
      const stored = state.messages[modify[1] as string];
      if (!stored) return notFound();
      const body = JSON.parse(request.body ?? "{}") as { addLabelIds?: string[]; removeLabelIds?: string[] };
      stored.labelIds = [...stored.labelIds.filter((l) => !(body.removeLabelIds ?? []).includes(l)), ...(body.addLabelIds ?? [])];
      return json(200, { id: modify[1], threadId: stored.threadId, labelIds: stored.labelIds });
    }
    const get = /^\/messages\/([^/]+)$/.exec(path);
    if (get && request.method === "GET") {
      const id = get[1] as string;
      const stored = state.messages[id];
      if (!stored) return notFound();
      return json(200, {
        id,
        threadId: stored.threadId,
        labelIds: stored.labelIds,
        snippet: "Bitte bis Freitag prüfen.",
        historyId: state.historyId,
        internalDate: stored.internalDate,
        sizeEstimate: Buffer.from(stored.raw, "base64url").length,
        raw: stored.raw,
      });
    }
    if (path === "/history") {
      if (state.historyStatus) return notFound();
      // Records after startHistoryId, paged like the real API (nextPageToken = offset).
      const start = BigInt(query.get("startHistoryId") ?? "0");
      const after = state.history.filter((record) => BigInt(record.id) > start);
      const offset = Number(query.get("pageToken") ?? "0");
      const size = Number(query.get("maxResults") ?? "100");
      const page = after.slice(offset, offset + size);
      return json(200, {
        ...(page.length > 0 ? { history: page } : {}),
        ...(offset + size < after.length ? { nextPageToken: String(offset + size) } : {}),
        historyId: state.historyId,
      });
    }
    if (path === "/labels" && request.method === "GET") return json(200, { labels: state.labels });
    if (path === "/labels" && request.method === "POST") {
      const body = JSON.parse(request.body ?? "{}") as { name: string };
      const label = { id: "Label_99", name: body.name, type: "user" as const };
      state.labels.push(label);
      return json(200, { ...label, messageListVisibility: "show", labelListVisibility: "labelShow" });
    }
    return json(500, { error: { code: 500, message: `unexpected ${request.method} ${path}` } });
  };
}

function setup(state: GmailState, tokens = fakeTokens()) {
  const http = mockFetch(gmailApi(state));
  const connector = new GmailConnector({ provider: "gmail", emailAddress: "anna@example.com", tokens: tokens.source }, { fetch: http.fetch });
  return { connector, requests: http.requests, tokens };
}

function request(folders: string[], cursors: Record<string, string> = {}, maxMessages = 50): FetchRequest {
  return {
    folders: folders.map((id) => ({ providerFolderId: id, role: id === "INBOX" ? "inbox" : id === "SPAM" ? "spam" : "other", uidValidity: null })),
    cursors,
    since: SINCE,
    maxMessages,
    maxMessageBytes: 200_000,
    ownAddresses: ["anna@example.com"],
  };
}

const upserts = (result: FetchResult): NormalizedMessage[] => result.changes.flatMap((c) => (c.kind === "upsert" ? [c.message] : []));

function baseState(): GmailState {
  return {
    historyId: "1000",
    messages: {
      m1: message("m1", ["INBOX", "UNREAD"], "Angebot"),
      m2: message("m2", ["INBOX", "STARRED"]),
      s1: message("s1", ["SPAM"]),
    },
    history: [],
    labels: [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "SPAM", name: "SPAM", type: "system" },
      { id: "TRASH", name: "TRASH", type: "system" },
      { id: "UNREAD", name: "UNREAD", type: "system" },
      { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
      { id: "Label_7", name: "Projekte/Kunde A", type: "user" },
    ],
  };
}

describe("Gmail-Connector (gemocktes fetch)", () => {
  it("Erstimport: messages.list mit q=after:<Sekunden>, format=raw durch processMime, Spam ausgeschlossen", async () => {
    const { connector, requests } = setup(baseState());
    const result = await connector.fetchChanges(request(["INBOX"]));
    const list = requests.find((r) => r.url.pathname.endsWith("/messages") && r.method === "GET");
    expect(list?.url.searchParams.get("labelIds")).toBe("INBOX");
    expect(list?.url.searchParams.get("q")).toBe(`after:${SINCE.getTime() / 1000}`);
    expect(list?.url.searchParams.has("includeSpamTrash")).toBe(false);
    const gets = requests.filter((r) => /\/messages\/[^/]+$/.test(r.url.pathname));
    expect(gets.map((r) => r.url.searchParams.get("format"))).toEqual(["raw", "raw"]);
    expect(requests.every((r) => r.headers.get("authorization") === "Bearer token-1")).toBe(true);

    const [m1, m2] = upserts(result);
    expect(m1).toMatchObject({
      identityKey: "gmail:m1",
      providerMessageId: "m1",
      providerThreadId: "t-m1",
      rfcMessageId: "<m1@example.org>",
      subject: "Angebot",
      labels: ["INBOX", "UNREAD"],
      webLink: "https://mail.google.com/mail/u/0/#search/rfc822msgid:m1%40example.org",
      location: { providerFolderId: "INBOX", uidValidity: null, uid: null, flags: [] },
      bodyText: "Bitte bis Freitag prüfen.",
    });
    expect(m1?.receivedAt?.toISOString()).toBe("2026-10-22T08:15:00.000Z");
    expect(m2?.location?.flags).toEqual(["\\Flagged", "\\Seen"]);
    expect(upserts(result).map((m) => m.identityKey)).not.toContain("gmail:s1");
    expect(result.complete).toBe(true);
    expect(result.cursorResets).toEqual([]);
    expect(result.cursors["gmail:*"]).toBeDefined();
  });

  it("Delta über users.history.list: Hinzufügen, Archivieren, Löschen, Papierkorb", async () => {
    const state = baseState();
    state.messages.m6 = message("m6", ["Label_7"]);
    const { connector, requests } = setup(state);
    const initial = await connector.fetchChanges(request(["INBOX", "Label_7"]));
    requests.length = 0;

    state.historyId = "1005";
    state.messages.m5 = message("m5", ["INBOX", "UNREAD"], "Neu");
    state.messages.m1 = { ...(state.messages.m1 as StoredMessage), labelIds: ["UNREAD"] };
    delete state.messages.m2;
    state.messages.m6 = { ...(state.messages.m6 as StoredMessage), labelIds: ["TRASH", "Label_7"] };
    state.history = [
      { id: "1001", messages: [{ id: "m5", threadId: "t-m5" }], messagesAdded: [{ message: { id: "m5", threadId: "t-m5", labelIds: ["INBOX", "UNREAD"] } }] },
      { id: "1002", messages: [{ id: "m1", threadId: "t-m1" }], labelsRemoved: [{ message: { id: "m1", threadId: "t-m1", labelIds: ["UNREAD"] }, labelIds: ["INBOX"] }] },
      { id: "1003", messages: [{ id: "m2", threadId: "t-m2" }], messagesDeleted: [{ message: { id: "m2", threadId: "t-m2" } }] },
      { id: "1004", messages: [{ id: "m6", threadId: "t-m6" }], labelsAdded: [{ message: { id: "m6", threadId: "t-m6", labelIds: ["TRASH", "Label_7"] }, labelIds: ["TRASH"] }] },
      { id: "1005", messages: [{ id: "d1", threadId: "t-d1" }], messagesAdded: [{ message: { id: "d1", threadId: "t-d1", labelIds: ["DRAFT"] } }] },
    ];
    const delta = await connector.fetchChanges(request(["INBOX", "Label_7"], initial.cursors));
    const history = requests.find((r) => r.url.pathname.endsWith("/history"));
    expect(history?.url.searchParams.get("startHistoryId")).toBe("1000");
    expect(history?.url.searchParams.getAll("historyTypes")).toEqual(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
    expect(delta.changes).toEqual([
      { kind: "deleted", identityKey: "gmail:m2" },
      { kind: "location_removed", identityKey: "gmail:m1", location: { providerFolderId: "INBOX", uidValidity: null, uid: null, flags: [] } },
      expect.objectContaining({ kind: "upsert", message: expect.objectContaining({ identityKey: "gmail:m5" }) }),
      { kind: "location_removed", identityKey: "gmail:m6", location: { providerFolderId: "Label_7", uidValidity: null, uid: null, flags: [] } },
    ]);
    const fetched = requests.filter((r) => /\/messages\/[^/]+$/.test(r.url.pathname)).map((r) => r.url.pathname.split("/").pop());
    expect(fetched).toEqual(["m5", "m1", "m6"]);
    expect(delta.complete).toBe(true);

    requests.length = 0;
    await connector.fetchChanges(request(["INBOX", "Label_7"], delta.cursors));
    expect(requests.find((r) => r.url.pathname.endsWith("/history"))?.url.searchParams.get("startHistoryId")).toBe("1005");
  });

  it("Cursor-Verlust: 404 auf history.list löst Neuimport und cursorResets aus", async () => {
    const state = baseState();
    const { connector, requests } = setup(state);
    const initial = await connector.fetchChanges(request(["INBOX"]));
    requests.length = 0;
    state.historyStatus = 404;
    state.historyId = "2000";
    const result = await connector.fetchChanges(request(["INBOX"], initial.cursors));
    expect(result.cursorResets).toEqual([{ providerFolderId: "INBOX", reason: "history_expired" }]);
    expect(upserts(result).map((m) => m.identityKey)).toEqual(["gmail:m1", "gmail:m2"]);
    expect(requests.map((r) => r.url.pathname.replace("/gmail/v1/users/me", ""))).toEqual(["/history", "/profile", "/messages", "/messages/m1", "/messages/m2"]);
    expect(result.complete).toBe(true);
  });

  it("401 → ein Refresh-Versuch → needs_reauth „Konto erneut verbinden“", async () => {
    const tokens = fakeTokens();
    const http = mockFetch(() =>
      json(401, { error: { code: 401, message: "Invalid Credentials", errors: [{ message: "Invalid Credentials", domain: "global", reason: "authError", location: "Authorization", locationType: "header" }], status: "UNAUTHENTICATED" } }),
    );
    const connector = new GmailConnector({ provider: "gmail", emailAddress: "anna@example.com", tokens: tokens.source }, { fetch: http.fetch });
    const error = await connector.verify().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: "needs_reauth", userAction: "Konto erneut verbinden" });
    expect(tokens.stats.invalidations).toBe(1);
    expect(http.requests.map((r) => r.headers.get("authorization"))).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("401 mit erfolgreichem Refresh läuft weiter", async () => {
    const tokens = fakeTokens();
    const state = baseState();
    const api = gmailApi(state);
    const http = mockFetch((r) => (r.headers.get("authorization") === "Bearer token-1" ? json(401, { error: { code: 401, message: "Invalid Credentials" } }) : api(r)));
    const connector = new GmailConnector({ provider: "gmail", emailAddress: "anna@example.com", tokens: tokens.source }, { fetch: http.fetch });
    const capabilities = await connector.verify();
    expect(capabilities).toMatchObject({ incrementalSync: "gmail_history", labels: true, webLinks: true, supportedMarkers: ["none", "gmail_label"] });
    expect(tokens.stats.invalidations).toBe(1);
  });

  it("429 mit Retry-After und 403-Kontingentfehler werden zu rate_limited, domainPolicy zu permission_denied", async () => {
    const cases: Array<[Response, Record<string, unknown>]> = [
      [json(429, { error: { code: 429, message: "Too many requests: User-rate limit exceeded" } }, { "Retry-After": "120" }), { code: "rate_limited", retryAfterSeconds: 120 }],
      [json(403, { error: { code: 403, message: "User Rate Limit Exceeded", errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded" }] } }), { code: "rate_limited", retryAfterSeconds: null }],
      [json(403, { error: { code: 403, message: "The domain administrators have disabled Gmail apps.", errors: [{ domain: "global", reason: "domainPolicy" }] } }), { code: "permission_denied", userAction: "Administrator um Freigabe für MailPilot bitten" }],
      [json(503, { error: { code: 503, message: "Backend Error" } }), { code: "server" }],
    ];
    for (const [response, expected] of cases) {
      const http = mockFetch(() => response.clone());
      const connector = new GmailConnector({ provider: "gmail", emailAddress: "anna@example.com", tokens: fakeTokens().source }, { fetch: http.fetch });
      await expect(connector.verify()).rejects.toMatchObject(expected);
    }
  });

  it("liest Spam nur, wenn der Ordner ausdrücklich gewählt ist", async () => {
    const { connector, requests } = setup(baseState());
    const result = await connector.fetchChanges(request(["INBOX", "SPAM"]));
    const lists = requests.filter((r) => r.url.pathname.endsWith("/messages") && r.method === "GET");
    expect(lists.map((r) => [r.url.searchParams.get("labelIds"), r.url.searchParams.get("includeSpamTrash")])).toEqual([
      ["INBOX", null],
      ["SPAM", "true"],
    ]);
    expect(upserts(result).find((m) => m.identityKey === "gmail:s1")?.location?.providerFolderId).toBe("SPAM");
  });

  it("teilt den Import nach maxMessages auf", async () => {
    const { connector } = setup(baseState());
    const first = await connector.fetchChanges(request(["INBOX"], {}, 1));
    expect([upserts(first).map((m) => m.identityKey), first.complete]).toEqual([["gmail:m1"], false]);
    const second = await connector.fetchChanges(request(["INBOX"], first.cursors, 1));
    expect([upserts(second).map((m) => m.identityKey), second.complete]).toEqual([["gmail:m2"], false]);
    const third = await connector.fetchChanges(request(["INBOX"], second.cursors, 1));
    expect([upserts(third), third.complete]).toEqual([[], true]);
  });

  it("Label-Marker: legt das Label an und setzt/entfernt es per messages.modify", async () => {
    const state = baseState();
    const { connector, requests } = setup(state);
    const marker = { strategy: "gmail_label" as const, keyword: null, folder: null, message: { providerMessageId: "m1", rfcMessageId: "<m1@example.org>", location: null } };
    expect(await connector.applyMarker(marker, "set")).toEqual({ status: "applied", detail: null });
    const created = requests.find((r) => r.method === "POST" && r.url.pathname.endsWith("/labels"));
    expect(JSON.parse(created?.body ?? "{}")).toEqual({ name: "MailPilot", labelListVisibility: "labelShow", messageListVisibility: "show" });
    const modify = requests.filter((r) => r.url.pathname.endsWith("/messages/m1/modify")).map((r) => JSON.parse(r.body ?? "{}"));
    expect(modify).toEqual([{ addLabelIds: ["Label_99"] }]);
    expect(state.messages.m1?.labelIds).toContain("Label_99");
    expect(await connector.applyMarker(marker, "clear")).toEqual({ status: "applied", detail: null });
    expect(state.messages.m1?.labelIds).not.toContain("Label_99");
    expect(requests.filter((r) => r.method === "POST" && r.url.pathname.endsWith("/labels"))).toHaveLength(1);
    expect(await connector.applyMarker({ ...marker, strategy: "graph_flag" }, "set")).toMatchObject({ status: "unsupported" });
    expect(await connector.applyMarker({ ...marker, message: { ...marker.message, providerMessageId: null } }, "set")).toMatchObject({ status: "failed" });
  });

  it("listFolders liefert Labels als Ordner ohne UNREAD und Kategorien-Tabs", async () => {
    const { connector } = setup(baseState());
    const folders = await connector.listFolders();
    expect(folders.map((f) => [f.providerFolderId, f.name, f.role])).toEqual([
      ["INBOX", "INBOX", "inbox"],
      ["SENT", "SENT", "sent"],
      ["SPAM", "SPAM", "spam"],
      ["TRASH", "TRASH", "trash"],
      ["Label_7", "Kunde A", "other"],
    ]);
  });

  it("Label-Marker mit Systemnamen (Inbox, Trash, Unread …) wird abgelehnt und ändert nichts", async () => {
    const state = baseState();
    const { connector, requests } = setup(state);
    for (const keyword of ["Inbox", "TRASH", "unread", "Starred", "CATEGORY_SOCIAL"]) {
      for (const operation of ["set", "clear"] as const) {
        const result = await connector.applyMarker(
          { strategy: "gmail_label", keyword, folder: null, message: { providerMessageId: "m1", rfcMessageId: null, location: null } },
          operation,
        );
        expect(result).toMatchObject({ status: "failed" });
      }
    }
    expect(requests.filter((r) => r.method === "POST")).toEqual([]);
    expect(state.messages.m1?.labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  it("abgewählte oder in Gmail gelöschte Labels blockieren den Abgleich nicht", async () => {
    const state = baseState();
    state.messages.l1 = message("l1", ["Label_7"]);
    const { connector, requests } = setup(state);
    const first = await connector.fetchChanges(request(["INBOX", "Label_7"], {}, 1));
    expect(first.complete).toBe(false);
    // Deselected while its import is still running: no further listing of Label_7.
    requests.length = 0;
    const second = await connector.fetchChanges(request(["INBOX"], first.cursors));
    expect(requests.some((r) => r.url.searchParams.get("labelIds") === "Label_7")).toBe(false);
    expect(second.complete).toBe(true);
    // Selected again, but deleted in Gmail meanwhile: reported once, no endless failure.
    state.deletedLabels = ["Label_7"];
    const third = await connector.fetchChanges(request(["INBOX", "Label_7"], second.cursors));
    expect(third.cursorResets).toEqual([{ providerFolderId: "Label_7", reason: "folder_missing" }]);
    const fourth = await connector.fetchChanges(request(["INBOX", "Label_7"], third.cursors));
    expect([fourth.cursorResets, fourth.complete]).toEqual([[], true]);
  });

  it("begrenzt die Warteschlange eines großen Deltas und setzt am History-Eintrag fort", async () => {
    const state = baseState();
    const { connector, requests } = setup(state);
    const initial = await connector.fetchChanges(request(["INBOX"]));
    state.history = Array.from({ length: 10_050 }, (_, i) => ({
      id: String(1001 + i),
      messagesAdded: [{ message: { id: `b${i}`, threadId: `t${i}`, labelIds: ["INBOX"] } }],
    }));
    state.historyId = String(1000 + 10_050);
    for (let i = 0; i < 10_050; i++) state.messages[`b${i}`] = message(`b${i}`, ["INBOX"]);
    const bulk = await connector.fetchChanges(request(["INBOX"], initial.cursors, 5));
    const cursor = JSON.parse(bulk.cursors["gmail:*"] ?? "{}") as { h: string; q: string[] };
    expect(bulk.complete).toBe(false);
    expect(cursor.q.length).toBe(10_000 - 5);
    expect(cursor.h).toBe(String(1000 + 10_000));
    requests.length = 0;
    const next = await connector.fetchChanges(request(["INBOX"], bulk.cursors, 20_000));
    expect(next.cursorResets).toEqual([]);
    const historyCall = requests.find((r) => r.url.pathname.endsWith("/history"));
    expect(historyCall?.url.searchParams.get("startHistoryId")).toBe(String(1000 + 10_000));
    expect(upserts(next)).toHaveLength(10_000 - 5 + 50);
    expect(next.complete).toBe(true);
  });

  it("meldet Gelesen- und Stern-Änderungen von Nachrichten in gewählten Ordnern", async () => {
    const state = baseState();
    state.messages.x1 = message("x1", ["Label_9"]);
    const { connector, requests } = setup(state);
    const initial = await connector.fetchChanges(request(["INBOX"]));
    requests.length = 0;
    state.historyId = "1003";
    state.messages.m1 = { ...(state.messages.m1 as StoredMessage), labelIds: ["INBOX", "STARRED"] };
    state.history = [
      { id: "1001", labelsRemoved: [{ message: { id: "m1", threadId: "t-m1", labelIds: ["INBOX"] }, labelIds: ["UNREAD"] }] },
      { id: "1002", labelsAdded: [{ message: { id: "m1", threadId: "t-m1", labelIds: ["INBOX", "STARRED"] }, labelIds: ["STARRED"] }] },
      { id: "1003", labelsRemoved: [{ message: { id: "x1", threadId: "t-x1", labelIds: ["Label_9"] }, labelIds: ["UNREAD"] }] },
    ];
    const result = await connector.fetchChanges(request(["INBOX"], initial.cursors));
    expect(upserts(result).map((m) => [m.identityKey, m.location?.flags])).toEqual([["gmail:m1", ["\\Flagged", "\\Seen"]]]);
    expect(requests.filter((r) => /\/messages\/[^/]+$/.test(r.url.pathname)).map((r) => r.url.pathname.split("/").pop())).toEqual(["m1"]);
  });
});

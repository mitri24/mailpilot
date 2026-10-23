import type { AccountCapabilities, FolderRole } from "@mailpilot/contracts";
import { z } from "zod";
import { normalizeMessageId, processMime } from "../content.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { connectorError, mapHttpError, readErrorBody } from "../errors.js";
import { ApiClient, type FetchLike } from "../http.js";
import { noopLogger, type ConnectorLogger } from "../logger.js";
import type {
  ConnectorAccount,
  FetchRequest,
  FetchResult,
  MailChange,
  MailConnector,
  MarkerRequest,
  MarkerResult,
  MessageLocation,
  NormalizedMessage,
  RemoteFolder,
} from "../types.js";

export type GmailAccount = Extract<ConnectorAccount, { provider: "gmail" }>;

export interface GmailConnectorOptions {
  fetch?: FetchLike;
  logger?: ConnectorLogger;
  /** Defaults to the public Gmail API. */
  baseUrl?: string;
}

export const GMAIL_CURSOR_KEY = "gmail:*";
export const DEFAULT_GMAIL_LABEL = "MailPilot";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const LIST_PAGE_SIZE = 100;
const HISTORY_PAGE_SIZE = 500;
/** System labels that are states or tabs rather than folders. */
const NON_FOLDER_LABELS = new Set(["UNREAD", "CHAT"]);
/** Labels that only change `location.flags` (\Seen, \Flagged). */
const FLAG_LABELS = new Set(["UNREAD", "STARRED"]);
/** Marker names that would hit Gmail system labels (archive, trash, read state …). */
const RESERVED_LABEL_NAME = /^(?:inbox|spam|trash|unread|starred|important|sent|draft|drafts|chat|category_[a-z]+)$/i;
/** One delta never queues more ids than this, so the cursor stays inside its schema. */
const MAX_PENDING_IDS = 10_000;

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  sizeEstimate?: number;
  raw?: string;
}

interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
}

interface HistoryMessageRef {
  message: { id: string; threadId?: string; labelIds?: string[] };
  labelIds?: string[];
}

interface HistoryRecord {
  id: string;
  messagesAdded?: HistoryMessageRef[];
  messagesDeleted?: HistoryMessageRef[];
  labelsAdded?: HistoryMessageRef[];
  labelsRemoved?: HistoryMessageRef[];
}

interface HistoryPage {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

const MessageId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const GmailCursor = z.object({
  v: z.literal(1),
  /** History id to continue from (taken before the import started). */
  h: z.string().regex(/^\d+$/),
  /** Labels the import has covered; newly selected labels get their own import. */
  sel: z.array(z.string()).max(10_000),
  /** Message ids of an interrupted delta that still have to be fetched. */
  q: z.array(MessageId).max(20_000),
  /** Running (re-)import of the window. */
  init: z
    .object({
      since: z.string(),
      labels: z.array(z.string()).max(10_000),
      page: z.string().nullable(),
      queue: z.array(MessageId).max(1000),
    })
    .nullable(),
});
type GmailCursor = z.infer<typeof GmailCursor>;

interface SyncContext {
  request: FetchRequest;
  selected: Set<string>;
  remaining: number;
  changes: MailChange[];
  fetched: Set<string>;
  cursorResets: FetchResult["cursorResets"];
}

export function gmailFolderRole(labelId: string): FolderRole {
  switch (labelId) {
    case "INBOX":
      return "inbox";
    case "SENT":
      return "sent";
    case "DRAFT":
      return "drafts";
    case "SPAM":
      return "spam";
    case "TRASH":
      return "trash";
    default:
      return "other";
  }
}

/** Search link by Message-ID; opens the first Google account signed in to the browser. */
export function gmailWebLink(rfcMessageId: string | null): string | null {
  const id = normalizeMessageId(rfcMessageId);
  return id ? `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(id)}` : null;
}

function gmailFlags(labelIds: string[]): string[] {
  const flags: string[] = [];
  if (labelIds.includes("STARRED")) flags.push("\\Flagged");
  if (!labelIds.includes("UNREAD")) flags.push("\\Seen");
  return flags;
}

function location(labelId: string, labelIds: string[]): MessageLocation {
  return { providerFolderId: labelId, uidValidity: null, uid: null, flags: gmailFlags(labelIds) };
}

function removedLocation(labelId: string): MessageLocation {
  return { providerFolderId: labelId, uidValidity: null, uid: null, flags: [] };
}

export class GmailConnector implements MailConnector {
  readonly provider = "gmail" as const;
  private readonly api: ApiClient;
  private readonly logger: ConnectorLogger;
  private labelCache: GmailLabel[] | null = null;

  constructor(
    private readonly account: GmailAccount,
    options: GmailConnectorOptions = {},
  ) {
    this.logger = options.logger ?? noopLogger;
    this.api = new ApiClient({
      provider: "gmail",
      baseUrl: options.baseUrl ?? GMAIL_BASE,
      fetch: options.fetch ?? fetch,
      tokens: account.tokens,
    });
  }

  async verify(): Promise<AccountCapabilities> {
    const profile = await this.api.json<{ emailAddress?: string; historyId?: string }>({ url: "/profile" });
    const notes = [
      "Markieren setzt ein Gmail-Label und braucht die Variante „mit Markierung“ (Berechtigung gmail.modify).",
      "Laut Google behandelt Gmail Labels bei IMAP-Zugriff als Ordner; ob und wo Apple Mail das Label anzeigt, ist nicht geprüft.",
      "Der Weblink sucht die Nachricht über ihre Message-ID im ersten im Browser angemeldeten Google-Konto.",
      "Spam und Papierkorb werden nur gelesen, wenn sie ausdrücklich ausgewählt sind.",
    ];
    const connected = profile.emailAddress?.toLowerCase();
    if (connected && connected !== this.account.emailAddress.toLowerCase()) {
      notes.push(`Das verbundene Google-Konto (${connected}) weicht von der hinterlegten Adresse ab.`);
    }
    return {
      incrementalSync: "gmail_history",
      customKeywords: false,
      flagged: false,
      labels: true,
      categories: false,
      copyToFolder: false,
      webLinks: true,
      immutableIds: true,
      supportedMarkers: ["none", "gmail_label"],
      notes,
    };
  }

  private async labels(refresh = false): Promise<GmailLabel[]> {
    if (!this.labelCache || refresh) {
      const response = await this.api.json<{ labels?: GmailLabel[] }>({ url: "/labels" });
      this.labelCache = response.labels ?? [];
    }
    return this.labelCache;
  }

  async listFolders(): Promise<RemoteFolder[]> {
    const labels = await this.labels(true);
    return labels
      .filter((label) => !NON_FOLDER_LABELS.has(label.id) && !label.id.startsWith("CATEGORY_"))
      .map((label) => ({
        providerFolderId: label.id,
        path: label.name,
        name: label.name.split("/").pop() || label.name,
        role: gmailFolderRole(label.id),
        uidValidity: null,
      }));
  }

  async fetchChanges(request: FetchRequest): Promise<FetchResult> {
    const ctx: SyncContext = {
      request,
      selected: new Set(request.folders.map((folder) => folder.providerFolderId)),
      remaining: Math.max(1, Math.floor(request.maxMessages)),
      changes: [],
      fetched: new Set(),
      cursorResets: [],
    };
    const cursorResets = ctx.cursorResets;
    const decoded = decodeCursor(request.cursors[GMAIL_CURSOR_KEY], GmailCursor);
    let cursor: GmailCursor;
    if (decoded.status === "ok") {
      cursor = decoded.value;
    } else {
      if (decoded.status === "invalid") {
        for (const id of ctx.selected) cursorResets.push({ providerFolderId: id, reason: "cursor_invalid" });
      }
      cursor = await this.startImport(request, [...ctx.selected]);
    }
    const added = [...ctx.selected].filter((label) => !cursor.sel.includes(label));
    cursor.sel = cursor.sel.filter((label) => ctx.selected.has(label));
    if (cursor.init) {
      // Deselected labels are not imported any further.
      const current = cursor.init.labels[0];
      cursor.init.labels = cursor.init.labels.filter((label) => ctx.selected.has(label));
      if (cursor.init.labels[0] !== current) cursor.init.page = null;
    }
    if (added.length > 0) {
      cursor.sel.push(...added);
      if (cursor.init) cursor.init.labels.push(...added.filter((label) => !cursor.init?.labels.includes(label)));
      else cursor.init = { since: request.since.toISOString(), labels: added, page: null, queue: [] };
    }

    cursor.q = await this.processQueue(cursor.q, ctx);
    if (cursor.init) await this.continueImport(cursor, ctx);
    let historyRead = false;
    if (!cursor.init && cursor.q.length === 0 && ctx.remaining > 0) {
      historyRead = true;
      const delta = await this.readHistory(cursor.h, ctx);
      if (delta === "expired") {
        for (const id of ctx.selected) cursorResets.push({ providerFolderId: id, reason: "history_expired" });
        cursor = await this.startImport(request, [...ctx.selected]);
        await this.continueImport(cursor, ctx);
      } else {
        cursor.h = delta.historyId;
        cursor.q = await this.processQueue(delta.fetch, ctx);
        if (delta.truncated) historyRead = false;
      }
    }
    return {
      changes: ctx.changes,
      cursors: { ...request.cursors, [GMAIL_CURSOR_KEY]: encodeCursor(cursor) },
      cursorResets,
      uidValidity: {},
      complete: historyRead && cursor.init === null && cursor.q.length === 0,
    };
  }

  private async startImport(request: FetchRequest, labels: string[]): Promise<GmailCursor> {
    // The history id is taken first, so changes during the import show up in the next delta.
    const profile = await this.api.json<{ historyId?: string }>({ url: "/profile" });
    if (!profile.historyId || !/^\d+$/.test(profile.historyId)) throw connectorError("server", "Gmail API: profile without historyId");
    return {
      v: 1,
      h: profile.historyId,
      sel: [...labels],
      q: [],
      init: { since: request.since.toISOString(), labels: [...labels], page: null, queue: [] },
    };
  }

  private async continueImport(cursor: GmailCursor, ctx: SyncContext): Promise<void> {
    const init = cursor.init;
    if (!init) return;
    const after = Math.floor(new Date(init.since).getTime() / 1000);
    while (ctx.remaining > 0) {
      const next = init.queue.shift();
      if (next !== undefined) {
        await this.emitMessage(next, ctx, false);
        continue;
      }
      const label = init.labels[0];
      if (label === undefined) break;
      const spamOrTrash = label === "SPAM" || label === "TRASH";
      const response = await this.api.request<{ messages?: Array<{ id: string }>; nextPageToken?: string }>({
        url: "/messages",
        query: {
          labelIds: label,
          q: `after:${after}`,
          maxResults: LIST_PAGE_SIZE,
          pageToken: init.page ?? undefined,
          // Spam and trash are only listed when the caller selected exactly these folders.
          includeSpamTrash: spamOrTrash ? true : undefined,
        },
        allowStatus: [400, 404],
      });
      if (response.status === 404 || (response.status === 400 && /label/i.test(readErrorBody(response.body).message ?? ""))) {
        // Label deleted in Gmail: report once and stop importing it instead of failing every run.
        ctx.cursorResets.push({ providerFolderId: label, reason: "folder_missing" });
        init.labels.shift();
        init.page = null;
        continue;
      }
      if (response.status !== 200 || !response.body) {
        throw mapHttpError("gmail", response.status, response.body, response.headers.get("retry-after"));
      }
      const page = response.body;
      init.queue = (page.messages ?? []).map((message) => message.id).filter((id) => !ctx.fetched.has(id));
      if (page.nextPageToken) {
        init.page = page.nextPageToken;
      } else {
        init.page = null;
        init.labels.shift();
      }
    }
    if (init.queue.length === 0 && init.labels.length === 0) cursor.init = null;
  }

  private async readHistory(
    startHistoryId: string,
    ctx: SyncContext,
  ): Promise<"expired" | { historyId: string; fetch: string[]; truncated: boolean }> {
    const relevant = new Set([...ctx.selected, "TRASH", "SPAM"]);
    const toFetch = new Set<string>();
    const deleted = new Set<string>();
    const removed = new Map<string, Set<string>>();
    const affects = (message: HistoryMessageRef["message"], labelIds: string[]): boolean => {
      if (labelIds.some((label) => relevant.has(label))) return true;
      // Read/star changes only matter for messages in selected folders; unknown labels → fetch.
      if (!labelIds.some((label) => FLAG_LABELS.has(label))) return false;
      return !message.labelIds || message.labelIds.some((label) => ctx.selected.has(label));
    };
    let historyId = startHistoryId;
    let truncated = false;
    let pageToken: string | undefined;
    pages: do {
      const response = await this.api.request<HistoryPage>({
        url: "/history",
        query: {
          startHistoryId,
          maxResults: HISTORY_PAGE_SIZE,
          pageToken,
          historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
        },
        allowStatus: [404],
      });
      // 404: startHistoryId is out of range; Google says a full sync is required.
      if (response.status === 404) return "expired";
      for (const record of response.body?.history ?? []) {
        for (const { message } of record.messagesAdded ?? []) {
          // History entries usually carry only id/threadId; without labels the message is fetched.
          if (!message.labelIds || message.labelIds.some((label) => relevant.has(label))) toFetch.add(message.id);
        }
        for (const { message, labelIds = [] } of record.labelsAdded ?? []) {
          if (affects(message, labelIds)) toFetch.add(message.id);
        }
        for (const { message, labelIds = [] } of record.labelsRemoved ?? []) {
          const selectedRemoved = labelIds.filter((label) => ctx.selected.has(label));
          if (selectedRemoved.length > 0) {
            const set = removed.get(message.id) ?? new Set<string>();
            for (const label of selectedRemoved) set.add(label);
            removed.set(message.id, set);
          }
          if (affects(message, labelIds)) toFetch.add(message.id);
        }
        for (const { message } of record.messagesDeleted ?? []) deleted.add(message.id);
        // Stop at a record boundary; the next call continues after this record.
        if (toFetch.size >= MAX_PENDING_IDS && /^\d+$/.test(record.id)) {
          historyId = record.id;
          truncated = true;
          break pages;
        }
      }
      if (response.body?.historyId) historyId = response.body.historyId;
      pageToken = response.body?.nextPageToken;
    } while (pageToken);

    for (const id of deleted) {
      toFetch.delete(id);
      removed.delete(id);
      ctx.changes.push({ kind: "deleted", identityKey: `gmail:${id}` });
    }
    for (const [id, labels] of removed) {
      for (const label of labels) {
        ctx.changes.push({ kind: "location_removed", identityKey: `gmail:${id}`, location: removedLocation(label) });
      }
    }
    return { historyId, fetch: [...toFetch].filter((id) => MessageId.safeParse(id).success), truncated };
  }

  private async processQueue(ids: string[], ctx: SyncContext): Promise<string[]> {
    for (let i = 0; i < ids.length; i++) {
      if (ctx.remaining <= 0) return ids.slice(i);
      await this.emitMessage(ids[i] as string, ctx, true);
    }
    return [];
  }

  /** Fetches one message (format=raw) and emits an upsert per selected label it carries. */
  private async emitMessage(id: string, ctx: SyncContext, reportGone: boolean): Promise<void> {
    if (ctx.fetched.has(id)) return;
    ctx.fetched.add(id);
    const response = await this.api.request<GmailMessage>({
      url: `/messages/${encodeURIComponent(id)}`,
      query: { format: "raw" },
      allowStatus: [404],
    });
    ctx.remaining -= 1;
    if (response.status === 404 || !response.body) {
      if (reportGone) ctx.changes.push({ kind: "deleted", identityKey: `gmail:${id}` });
      return;
    }
    const message = response.body;
    const labelIds = message.labelIds ?? [];
    const present = labelIds.filter((label) => ctx.selected.has(label));
    const hidden =
      (labelIds.includes("TRASH") && !ctx.selected.has("TRASH")) || (labelIds.includes("SPAM") && !ctx.selected.has("SPAM"));
    if (hidden) {
      for (const label of present) {
        ctx.changes.push({ kind: "location_removed", identityKey: `gmail:${id}`, location: removedLocation(label) });
      }
      return;
    }
    if (present.length === 0) return;
    const normalized = await this.normalize(message, ctx.request.maxMessageBytes);
    for (const label of present) {
      ctx.changes.push({ kind: "upsert", message: { ...normalized, location: location(label, labelIds) } });
    }
  }

  private async normalize(message: GmailMessage, maxMessageBytes: number): Promise<NormalizedMessage> {
    const raw = Buffer.from(message.raw ?? "", "base64url");
    const content = await processMime(raw, { maxMessageBytes, sizeBytes: message.sizeEstimate ?? null });
    return {
      identityKey: `gmail:${message.id}`,
      providerMessageId: message.id,
      providerThreadId: message.threadId ?? null,
      receivedAt: message.internalDate && /^\d+$/.test(message.internalDate) ? new Date(Number(message.internalDate)) : null,
      webLink: gmailWebLink(content.rfcMessageId),
      location: null,
      labels: message.labelIds ?? [],
      ...content,
    };
  }

  async applyMarker(request: MarkerRequest, operation: "set" | "clear"): Promise<MarkerResult> {
    if (request.strategy === "none") return { status: "applied", detail: "Keine Markierung konfiguriert" };
    if (request.strategy !== "gmail_label") {
      return { status: "unsupported", detail: `Strategie ${request.strategy} gibt es für Gmail nicht` };
    }
    const id = request.message.providerMessageId;
    if (!id || !MessageId.safeParse(id).success) return { status: "failed", detail: "Gmail-Nachrichten-ID fehlt" };
    const name = request.keyword?.trim() || DEFAULT_GMAIL_LABEL;
    // A system label here would archive, trash or mark mail as read.
    if (RESERVED_LABEL_NAME.test(name)) return { status: "failed", detail: "Dieser Name ist für Gmail-Systemlabels reserviert" };
    const labelId = await this.findLabel(name, operation === "set");
    if (!labelId) return { status: "applied", detail: "not_present" };
    const response = await this.api.request({
      method: "POST",
      url: `/messages/${encodeURIComponent(id)}/modify`,
      body: operation === "set" ? { addLabelIds: [labelId] } : { removeLabelIds: [labelId] },
      allowStatus: [404],
    });
    if (response.status === 404) return { status: "failed", detail: "Nachricht nicht gefunden" };
    return { status: "applied", detail: null };
  }

  private async findLabel(name: string, create: boolean): Promise<string | null> {
    const match = (labels: GmailLabel[]): GmailLabel | undefined => {
      const own = labels.filter((label) => label.type === "user");
      return own.find((label) => label.name === name) ?? own.find((label) => label.name.toLowerCase() === name.toLowerCase());
    };
    let label = match(await this.labels());
    if (!label) label = match(await this.labels(true));
    if (label) return label.id;
    if (!create) return null;
    const response = await this.api.request<GmailLabel>({
      method: "POST",
      url: "/labels",
      body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
      allowStatus: [409],
    });
    if (response.status === 409) {
      const existing = match(await this.labels(true));
      if (existing) return existing.id;
      throw connectorError("server", "Gmail API: label conflict");
    }
    if (!response.body?.id) throw connectorError("server", "Gmail API: label created without id");
    this.labelCache = [...(this.labelCache ?? []), response.body];
    this.logger.info({ provider: "gmail" }, "Gmail label created");
    return response.body.id;
  }

  async close(): Promise<void> {
    this.labelCache = null;
  }
}

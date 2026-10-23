import type { AccountCapabilities, FolderRole } from "@mailpilot/contracts";
import { z } from "zod";
import { computeHeadersFingerprint, normalizeMessageId, processBody } from "../content.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { connectorError, mapHttpError, readErrorBody } from "../errors.js";
import { ApiClient, type ApiResponse, type FetchLike } from "../http.js";
import { noopLogger, type ConnectorLogger } from "../logger.js";
import type {
  ConnectorAccount,
  FetchFolder,
  FetchRequest,
  FetchResult,
  MailChange,
  MailConnector,
  MarkerRequest,
  MarkerResult,
  NormalizedAddress,
  NormalizedAttachment,
  NormalizedMessage,
  RemoteFolder,
} from "../types.js";

export type MicrosoftAccount = Extract<ConnectorAccount, { provider: "microsoft" }>;

export interface MicrosoftConnectorOptions {
  fetch?: FetchLike;
  logger?: ConnectorLogger;
  /** Defaults to Microsoft Graph v1.0. */
  baseUrl?: string;
}

export const DEFAULT_GRAPH_CATEGORY = "MailPilot";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Sent on every request: the header only applies to the request it is part of. */
const PREFER_IMMUTABLE = 'IdType="ImmutableId"';
const MESSAGE_SELECT = [
  "id",
  "conversationId",
  "internetMessageId",
  "subject",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "receivedDateTime",
  "sentDateTime",
  "body",
  "hasAttachments",
  "webLink",
  "categories",
  "flag",
  "isRead",
  "parentFolderId",
].join(",");
const WELL_KNOWN_FOLDERS: Array<[string, FolderRole]> = [
  ["inbox", "inbox"],
  ["sentitems", "sent"],
  ["deleteditems", "trash"],
  ["junkemail", "spam"],
  ["archive", "archive"],
  ["drafts", "drafts"],
];

/** Cursor keys follow `${ProviderKind}:${providerFolderId}`. */
export function graphCursorKey(folderId: string): string {
  return `microsoft:${folderId}`;
}

const GraphCursor = z.object({
  v: z.literal(1),
  /** @odata.deltaLink of the last finished round, or @odata.nextLink of a round in progress. */
  url: z.string().max(32_768),
  paging: z.boolean(),
  /** Folder answered 404 last time (already reported as folder_missing). */
  missing: z.boolean().optional(),
});

interface GraphRecipient {
  emailAddress?: { name?: string | null; address?: string | null } | null;
}

interface GraphMessage {
  id: string;
  "@removed"?: { reason?: string };
  conversationId?: string | null;
  internetMessageId?: string | null;
  subject?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  hasAttachments?: boolean | null;
  webLink?: string | null;
  categories?: string[] | null;
  flag?: { flagStatus?: string | null } | null;
  isRead?: boolean | string | null;
  parentFolderId?: string | null;
}

interface GraphPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface GraphFolder {
  id: string;
  displayName?: string | null;
  childFolderCount?: number | null;
  "@odata.type"?: string;
}

interface SyncContext {
  request: FetchRequest;
  remaining: number;
  changes: MailChange[];
  cursorResets: FetchResult["cursorResets"];
}

function recipient(value: GraphRecipient | null | undefined): NormalizedAddress | null {
  const address = value?.emailAddress?.address?.trim().toLowerCase();
  return address ? { name: value?.emailAddress?.name?.trim() || null, address } : null;
}

function recipients(values: GraphRecipient[] | null | undefined): NormalizedAddress[] {
  return (values ?? []).map(recipient).filter((entry): entry is NormalizedAddress => entry !== null);
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  return { value: Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, ""), truncated: true };
}

function isSyncStateError(status: number, body: unknown): boolean {
  if (status === 410) return true;
  const details = readErrorBody(body);
  return [details.code ?? "", ...details.reasons].some((code) => /syncstate|resync/i.test(code));
}

export class MicrosoftConnector implements MailConnector {
  readonly provider = "microsoft" as const;
  private readonly api: ApiClient;
  private readonly logger: ConnectorLogger;
  private readonly baseUrl: string;

  constructor(
    private readonly account: MicrosoftAccount,
    options: MicrosoftConnectorOptions = {},
  ) {
    this.logger = options.logger ?? noopLogger;
    this.baseUrl = options.baseUrl ?? GRAPH_BASE;
    this.api = new ApiClient({
      provider: "microsoft",
      baseUrl: this.baseUrl,
      fetch: options.fetch ?? fetch,
      tokens: account.tokens,
      defaultHeaders: { Prefer: PREFER_IMMUTABLE },
    });
  }

  async verify(): Promise<AccountCapabilities> {
    await this.api.json<{ id: string }>({ url: "/me/mailFolders/inbox", query: { $select: "id" } });
    return {
      incrementalSync: "graph_delta",
      customKeywords: false,
      flagged: true,
      labels: false,
      categories: true,
      copyToFolder: false,
      webLinks: true,
      immutableIds: true,
      supportedMarkers: ["none", "graph_category", "graph_flag"],
      notes: [
        "Markieren braucht die Variante „mit Markierung“ (Berechtigung Mail.ReadWrite).",
        "Outlook-Kategorien sind in Outlook sichtbar; Apple Mail zeigt Kategorien nach unserem Kenntnisstand nicht an (nicht geprüft).",
        "Die Nachverfolgungs-Kennzeichnung („Flag“) zeigt Outlook als Fähnchen; ob Apple Mail sie anzeigt, hängt von der Kontoart ab und ist nicht geprüft. MailPilot kann eine selbst gesetzte Kennzeichnung nicht von Ihrer eigenen unterscheiden.",
        "Nachrichten, die älter als das Importfenster sind und später in einen ausgewählten Ordner verschoben werden, meldet die Delta-Abfrage nicht.",
      ],
    };
  }

  private async wellKnownRoles(): Promise<Map<string, FolderRole>> {
    const roles = new Map<string, FolderRole>();
    for (const [name, role] of WELL_KNOWN_FOLDERS) {
      const response = await this.api.request<{ id?: string }>({
        url: `/me/mailFolders/${name}`,
        query: { $select: "id" },
        allowStatus: [404],
      });
      if (response.status !== 404 && response.body?.id) roles.set(response.body.id, role);
    }
    return roles;
  }

  async listFolders(): Promise<RemoteFolder[]> {
    const roles = await this.wellKnownRoles();
    const folders: RemoteFolder[] = [];
    const walk = async (start: string, parentPath: string | null): Promise<void> => {
      let next: string | undefined = start;
      while (next) {
        const page: GraphPage<GraphFolder> = await this.api.json<GraphPage<GraphFolder>>({ url: next });
        for (const folder of page.value ?? []) {
          if (folder["@odata.type"]?.toLowerCase().includes("mailsearchfolder")) continue;
          const name = folder.displayName ?? folder.id;
          const path = parentPath ? `${parentPath}/${name}` : name;
          folders.push({ providerFolderId: folder.id, path, name, role: roles.get(folder.id) ?? "other", uidValidity: null });
          if ((folder.childFolderCount ?? 0) > 0) {
            await walk(`/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders?$top=100`, path);
          }
        }
        next = page["@odata.nextLink"];
      }
    };
    await walk("/me/mailFolders?$top=100", null);
    return folders;
  }

  private initialDeltaUrl(folderId: string, since: Date): string {
    const params = new URLSearchParams({
      $select: MESSAGE_SELECT,
      // DateTimeOffset literal without fractional seconds, as in the delta documentation.
      $filter: `receivedDateTime ge ${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    });
    return `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?${params.toString()}`;
  }

  async fetchChanges(request: FetchRequest): Promise<FetchResult> {
    const ctx: SyncContext = {
      request,
      remaining: Math.max(1, Math.floor(request.maxMessages)),
      changes: [],
      cursorResets: [],
    };
    const cursors: Record<string, string> = { ...request.cursors };
    let complete = true;
    for (const folder of request.folders) {
      if (ctx.remaining <= 0) {
        complete = false;
        break;
      }
      const key = graphCursorKey(folder.providerFolderId);
      const decoded = decodeCursor(request.cursors[key], GraphCursor);
      let url: string;
      const wasMissing = decoded.status === "ok" && decoded.value.missing === true;
      if (decoded.status === "ok" && this.api.isApiUrl(decoded.value.url)) {
        url = decoded.value.url;
      } else {
        if (decoded.status !== "missing") ctx.cursorResets.push({ providerFolderId: folder.providerFolderId, reason: "cursor_invalid" });
        url = this.initialDeltaUrl(folder.providerFolderId, request.since);
      }
      const outcome = await this.syncFolder(folder, url, ctx);
      if (outcome === null) {
        // Tombstone instead of dropping the cursor (callers may keep the old one): report once.
        if (!wasMissing) ctx.cursorResets.push({ providerFolderId: folder.providerFolderId, reason: "folder_missing" });
        cursors[key] = encodeCursor({
          v: 1,
          url: `${this.baseUrl}${this.initialDeltaUrl(folder.providerFolderId, request.since)}`,
          paging: false,
          missing: true,
        });
        continue;
      }
      cursors[key] = encodeCursor({ v: 1, url: outcome.url, paging: outcome.paging });
      if (outcome.paging) complete = false;
    }
    return { changes: ctx.changes, cursors, cursorResets: ctx.cursorResets, uidValidity: {}, complete };
  }

  private async syncFolder(folder: FetchFolder, startUrl: string, ctx: SyncContext): Promise<{ url: string; paging: boolean } | null> {
    let url = startUrl;
    let reset = false;
    for (;;) {
      const pageSize = Math.max(1, Math.min(50, ctx.remaining));
      const response: ApiResponse<GraphPage<GraphMessage>> = await this.api.request<GraphPage<GraphMessage>>({
        url,
        headers: { Prefer: `${PREFER_IMMUTABLE}, odata.maxpagesize=${pageSize}` },
        allowStatus: [400, 404, 410],
      });
      if (response.status !== 200) {
        if (isSyncStateError(response.status, response.body) && !reset) {
          // Expired or reset delta token: start a new round inside the import window.
          ctx.cursorResets.push({ providerFolderId: folder.providerFolderId, reason: "delta_token_expired" });
          url = this.initialDeltaUrl(folder.providerFolderId, ctx.request.since);
          reset = true;
          continue;
        }
        if (response.status === 404) return null;
        throw mapHttpError("microsoft", response.status, response.body, response.headers.get("retry-after"));
      }
      const page = response.body ?? {};
      for (const item of page.value ?? []) await this.handleItem(folder, item, ctx);
      const next = page["@odata.nextLink"];
      const delta = page["@odata.deltaLink"];
      if (next) {
        if (!this.api.isApiUrl(next)) throw connectorError("server", "Microsoft Graph: nextLink outside Graph");
        if (ctx.remaining <= 0) return { url: next, paging: true };
        url = next;
        continue;
      }
      if (delta) {
        if (!this.api.isApiUrl(delta)) throw connectorError("server", "Microsoft Graph: deltaLink outside Graph");
        return { url: delta, paging: false };
      }
      throw connectorError("server", "Microsoft Graph: delta page without nextLink or deltaLink");
    }
  }

  private async handleItem(folder: FetchFolder, item: GraphMessage, ctx: SyncContext): Promise<void> {
    const identityKey = `graph:${item.id}`;
    if (item["@removed"]) {
      // "@removed" covers both moves and deletions; a lookup by immutable id tells them apart.
      const lookup = await this.api.request({
        url: `/me/messages/${encodeURIComponent(item.id)}`,
        query: { $select: "id" },
        allowStatus: [404],
      });
      if (lookup.status === 404) ctx.changes.push({ kind: "deleted", identityKey });
      else {
        ctx.changes.push({
          kind: "location_removed",
          identityKey,
          location: { providerFolderId: folder.providerFolderId, uidValidity: null, uid: null, flags: [] },
        });
      }
      return;
    }
    let message = item;
    if (message.body === undefined || message.receivedDateTime === undefined) {
      const full = await this.api.request<GraphMessage>({
        url: `/me/messages/${encodeURIComponent(item.id)}`,
        query: { $select: MESSAGE_SELECT },
        allowStatus: [404],
      });
      if (full.status === 404 || !full.body) {
        ctx.changes.push({ kind: "deleted", identityKey });
        return;
      }
      message = full.body;
    }
    ctx.changes.push({ kind: "upsert", message: await this.normalize(message, folder.providerFolderId, ctx.request.maxMessageBytes) });
    ctx.remaining -= 1;
  }

  private async attachments(messageId: string): Promise<NormalizedAttachment[]> {
    const out: NormalizedAttachment[] = [];
    // $select keeps contentBytes out of the response; contents are never downloaded.
    let next: string | undefined = `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=name,contentType,size,isInline`;
    while (next) {
      const page: GraphPage<{ name?: string | null; contentType?: string | null; size?: number | null; isInline?: boolean | null }> =
        await this.api.json({ url: next });
      for (const attachment of page.value ?? []) {
        out.push({
          filename: attachment.name ?? null,
          contentType: attachment.contentType ?? null,
          size: typeof attachment.size === "number" ? attachment.size : null,
          inline: attachment.isInline === true,
        });
      }
      next = page["@odata.nextLink"];
    }
    return out;
  }

  private async normalize(message: GraphMessage, folderId: string, maxMessageBytes: number): Promise<NormalizedMessage> {
    const type = message.body?.contentType?.toLowerCase();
    const limit = Math.max(1, Math.floor(maxMessageBytes));
    const content = truncateUtf8(message.body?.content ?? "", limit);
    const html = type === "html" ? content.value : null;
    const body = processBody({ html, text: type === "html" ? null : content.value });
    // hasAttachments ignores inline attachments, so cid: references in the body also trigger the lookup.
    const needsAttachments = message.hasAttachments === true || (html !== null && /src\s*=\s*["']?\s*cid:/i.test(html));
    const attachments = needsAttachments ? await this.attachments(message.id) : [];
    const messageId = normalizeMessageId(message.internetMessageId);
    const from = recipient(message.from) ?? recipient(message.sender);
    const subject = message.subject?.trim() || null;
    const sentAt = parseDate(message.sentDateTime);
    const flags: string[] = [];
    if (message.flag?.flagStatus === "flagged") flags.push("\\Flagged");
    if (message.isRead === true || message.isRead === "true") flags.push("\\Seen");
    return {
      identityKey: `graph:${message.id}`,
      providerMessageId: message.id,
      providerThreadId: message.conversationId ?? null,
      rfcMessageId: messageId ? `<${messageId}>` : null,
      inReplyTo: null,
      references: [],
      from,
      to: recipients(message.toRecipients),
      cc: recipients(message.ccRecipients),
      subject,
      sentAt,
      receivedAt: parseDate(message.receivedDateTime),
      ...body,
      attachments,
      sizeBytes: null,
      headersFingerprint: computeHeadersFingerprint({
        from: from?.address ?? null,
        date: sentAt ? sentAt.toISOString() : null,
        subject,
        messageId,
      }),
      webLink: message.webLink ?? null,
      location: { providerFolderId: folderId, uidValidity: null, uid: null, flags },
      labels: message.categories ?? [],
      truncated: content.truncated,
    };
  }

  async applyMarker(request: MarkerRequest, operation: "set" | "clear"): Promise<MarkerResult> {
    if (request.strategy === "none") return { status: "applied", detail: "Keine Markierung konfiguriert" };
    if (request.strategy !== "graph_category" && request.strategy !== "graph_flag") {
      return { status: "unsupported", detail: `Strategie ${request.strategy} gibt es für Microsoft-Konten nicht` };
    }
    const id = request.message.providerMessageId;
    if (!id) return { status: "failed", detail: "Graph-Nachrichten-ID fehlt" };
    const path = `/me/messages/${encodeURIComponent(id)}`;
    const current = await this.api.request<GraphMessage>({
      url: path,
      query: { $select: request.strategy === "graph_flag" ? "id,flag" : "id,categories" },
      allowStatus: [404],
    });
    if (current.status === 404 || !current.body) return { status: "failed", detail: "Nachricht nicht gefunden" };

    let patch: Record<string, unknown>;
    if (request.strategy === "graph_flag") {
      const flagged = current.body.flag?.flagStatus === "flagged";
      if (operation === "set" && flagged) return { status: "applied", detail: "already_present" };
      if (operation === "clear" && !flagged) return { status: "applied", detail: "not_present" };
      patch = { flag: { flagStatus: operation === "set" ? "flagged" : "notFlagged" } };
    } else {
      const name = request.keyword?.trim() || DEFAULT_GRAPH_CATEGORY;
      const categories = current.body.categories ?? [];
      const has = categories.includes(name);
      if (operation === "set" && has) return { status: "applied", detail: "already_present" };
      if (operation === "clear" && !has) return { status: "applied", detail: "not_present" };
      patch = { categories: operation === "set" ? [...categories, name] : categories.filter((category) => category !== name) };
    }
    const updated = await this.api.request({ method: "PATCH", url: path, body: patch, allowStatus: [404] });
    if (updated.status === 404) return { status: "failed", detail: "Nachricht nicht gefunden" };
    this.logger.debug({ provider: "microsoft", strategy: request.strategy, operation }, "Graph marker applied");
    return { status: "applied", detail: null };
  }

  async close(): Promise<void> {}
}

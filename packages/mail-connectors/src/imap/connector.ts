import type { ConnectionOptions } from "node:tls";
import type { AccountCapabilities, MarkerStrategy } from "@mailpilot/contracts";
import type { ExpungeEvent, FetchMessageObject, ImapFlowOptions, MailboxObject, SearchObject } from "imapflow";
import { z } from "zod";
import { normalizeMessageId, processMime } from "../content.js";
import { decodeCursor, encodeCursor, type DecodedCursor } from "../cursor.js";
import { connectorError, isConnectorError, mapImapError } from "../errors.js";
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
  NormalizedMessage,
  RemoteFolder,
} from "../types.js";
import { createImapFlowClient, imapflowLogger, type ImapClient, type ImapClientFactory } from "./client.js";
import { imapFolderRole } from "./folders.js";
import { UidSet, toSequenceSet } from "./uid-set.js";

export type ImapAccount = Extract<ConnectorAccount, { provider: "imap" }>;

export interface ImapConnectorOptions {
  /** Extra TLS options (e.g. a test CA). Never used to allow plaintext. */
  tls?: ConnectionOptions;
  logger?: ConnectorLogger;
  /** Test seam; defaults to a real ImapFlow client. */
  createClient?: ImapClientFactory;
  connectionTimeoutMs?: number;
}

/** Marks copies created by the imap_copy_folder strategy so `clear` never deletes anything else. */
export const COPY_MARKER_KEYWORD = "$MailPilotCopy";

const FolderCursor = z.object({
  v: z.literal(1),
  /** UIDVALIDITY the cursor belongs to. */
  uv: z.string().regex(/^\d+$/),
  /** Highest UID handled; every UID up to here was imported or is outside the import window. */
  last: z.number().int().min(0),
  /** UIDs of imported messages still present in the folder (sequence set). */
  known: z.string().max(4_000_000),
  /** CONDSTORE: flag changes up to this mod-sequence are reported. */
  ms: z.string().regex(/^\d+$/).nullable(),
  /** CONDSTORE: target mod-sequence of a flag scan that ran out of budget. */
  msTarget: z.string().regex(/^\d+$/).nullable(),
  /** CONDSTORE: UIDs up to here are done in the running flag scan. */
  fcAfter: z.number().int().min(0),
  /** Import window of a (re-)import that is not finished yet. */
  since: z.string().nullable(),
});
type FolderCursor = z.infer<typeof FolderCursor>;

export function imapCursorKey(path: string): string {
  return `imap:${path}`;
}

interface SyncContext {
  request: FetchRequest;
  remaining: number;
  changes: MailChange[];
  cursorResets: FetchResult["cursorResets"];
  complete: boolean;
}

const KEYWORD_ATOM = /^[^\s(){%*"\\\]\x00-\x1f\x7f]+$/;
const ascending = (a: number, b: number): number => a - b;
/** Stays below UidSet's parse limit and the cursor schema, so an encoded cursor always decodes. */
const MAX_TRACKED_UIDS = 400_000;
const MAX_KNOWN_CHARS = 3_500_000;

/**
 * imapflow resolves SEARCH with `undefined` once the connection is gone (no mailbox selected);
 * reading that as "no results" would report every known message as removed.
 */
function searchResult(result: number[] | false | undefined, context: string): number[] {
  if (result === false) throw connectorError("server", `${context}: SEARCH was rejected`);
  if (!Array.isArray(result)) throw connectorError("network", `${context}: IMAP connection lost`);
  return result;
}

/** FETCH responses for one UID may arrive split or interleaved with unsolicited FLAGS updates. */
function mergeRows(rows: FetchMessageObject[]): Map<number, FetchMessageObject> {
  const merged = new Map<number, FetchMessageObject>();
  for (const row of rows) {
    if (typeof row.uid !== "number") continue;
    const existing = merged.get(row.uid);
    if (!existing) {
      merged.set(row.uid, { ...row });
      continue;
    }
    for (const [key, value] of Object.entries(row)) {
      if (value !== undefined) (existing as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function isGmailImap(client: ImapClient): boolean {
  return client.capabilities.has("X-GM-EXT-1");
}

function flagList(flags: Set<string> | undefined): string[] {
  return [...(flags ?? [])].filter((flag) => flag !== "\\Recent").sort();
}

function allowsFlag(permanentFlags: Set<string> | undefined, flag: string): boolean {
  // RFC 3501 §7.1: without PERMANENTFLAGS all flags can be changed permanently.
  return !permanentFlags || permanentFlags.has("\\*") || permanentFlags.has(flag);
}

export class ImapConnector implements MailConnector {
  readonly provider = "imap" as const;
  private client: ImapClient | null = null;
  private readonly logger: ConnectorLogger;

  constructor(
    private readonly account: ImapAccount,
    private readonly options: ImapConnectorOptions = {},
  ) {
    this.logger = options.logger ?? noopLogger;
  }

  private clientOptions(): ImapFlowOptions {
    const { host, port, secure, username, password } = this.account.imap;
    return {
      host,
      port,
      secure,
      // Without implicit TLS the upgrade is mandatory; imapflow fails instead of staying in cleartext.
      ...(secure ? {} : { doSTARTTLS: true }),
      auth: { user: username, pass: password },
      ...(this.options.tls ? { tls: this.options.tls } : {}),
      logger: imapflowLogger(this.logger),
      disableAutoIdle: true,
      qresync: true,
      connectionTimeout: this.options.connectionTimeoutMs ?? 30_000,
      greetingTimeout: 16_000,
      socketTimeout: 300_000,
    };
  }

  private dropClient(): void {
    const client = this.client;
    this.client = null;
    try {
      client?.close();
    } catch {
      // already closed
    }
  }

  private async connection(): Promise<ImapClient> {
    if (this.client?.usable) return this.client;
    this.dropClient();
    const client = (this.options.createClient ?? createImapFlowClient)(this.clientOptions());
    client.on("error", (err: Error & { code?: string }) => {
      this.logger.warn({ provider: "imap", code: err.code }, "IMAP connection error");
    });
    try {
      await client.connect();
    } catch (err) {
      try {
        client.close();
      } catch {
        // ignore
      }
      throw mapImapError(err, "IMAP connect");
    }
    this.client = client;
    return client;
  }

  private async run<T>(context: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      const mapped = isConnectorError(err) ? err : mapImapError(err, context);
      if (mapped.code === "network" || mapped.code === "tls" || !this.client?.usable) this.dropClient();
      throw mapped;
    }
  }

  async verify(): Promise<AccountCapabilities> {
    return this.run("IMAP verify", async () => {
      const client = await this.connection();
      // SELECT (read-write) is needed: in EXAMINE mode servers may report empty PERMANENTFLAGS.
      const lock = await client.getMailboxLock("INBOX");
      let permanentFlags: Set<string> | undefined;
      let modseq = false;
      try {
        const mailbox = client.mailbox;
        permanentFlags = mailbox ? mailbox.permanentFlags : undefined;
        modseq = Boolean(mailbox && !mailbox.noModseq && mailbox.highestModseq !== undefined);
      } finally {
        lock.release();
      }
      return this.describeCapabilities(client, permanentFlags, modseq);
    });
  }

  private describeCapabilities(client: ImapClient, permanentFlags: Set<string> | undefined, modseq: boolean): AccountCapabilities {
    const condstore = client.enabled.has("CONDSTORE") && modseq;
    const customKeywords = !permanentFlags || permanentFlags.has("\\*");
    const flagged = allowsFlag(permanentFlags, "\\Flagged");
    const uidplus = client.capabilities.has("UIDPLUS");
    // On Gmail, COPY only adds a label: the "copy" would be the original message.
    const copyToFolder = !isGmailImap(client);
    const supportedMarkers: MarkerStrategy[] = ["none"];
    if (customKeywords) supportedMarkers.push("imap_keyword");
    if (flagged) supportedMarkers.push("imap_flagged");
    if (copyToFolder) supportedMarkers.push("imap_copy_folder");
    const notes: string[] = [];
    notes.push(
      customKeywords
        ? "Eigene Schlagwörter (IMAP-Keywords) speichert der Server, Apple Mail zeigt sie aber nicht an – sie dienen nur MailPilot zur Wiedererkennung."
        : "Der Server erlaubt keine eigenen Schlagwörter (PERMANENTFLAGS ohne \\*); die Strategie „Schlagwort“ ist nicht verfügbar.",
    );
    if (flagged) {
      notes.push(
        "„Markiert“ (\\Flagged) erscheint in Apple Mail als Fähnchen. MailPilot kann eine selbst gesetzte Markierung nicht von Ihrer eigenen unterscheiden: Beim Aufheben wird \\Flagged entfernt, auch wenn Sie die Nachricht zusätzlich selbst markiert haben.",
      );
    }
    notes.push(
      !copyToFolder
        ? "„Kopie in Ordner“ ist bei Gmail über IMAP nicht verfügbar: Kopieren vergibt dort nur ein Label, die „Kopie“ wäre die Originalnachricht."
        : uidplus
          ? "„Kopie in Ordner“ legt eine Kopie im gewählten Ordner an; Apple Mail zeigt sie dort als eigene Nachricht. Beim Aufheben wird nur diese Kopie gelöscht."
          : "„Kopie in Ordner“ ist möglich, das Aufheben aber nicht: Ohne UIDPLUS kann MailPilot die Kopie nicht gezielt löschen.",
    );
    notes.push(
      condstore
        ? "Änderungen an Markierungen werden über CONDSTORE erkannt."
        : "Der Server unterstützt kein CONDSTORE: Neue und gelöschte Nachrichten werden erkannt, Änderungen an Markierungen bekannter Nachrichten nicht.",
    );
    notes.push("Für IMAP-Konten gibt es keinen Weblink zur Originalnachricht; Nachrichten werden über die Message-ID wiedererkannt.");
    return {
      incrementalSync: condstore ? "imap_condstore" : "imap_uid",
      customKeywords,
      flagged,
      labels: false,
      categories: false,
      copyToFolder,
      webLinks: false,
      immutableIds: false,
      supportedMarkers,
      notes,
    };
  }

  async listFolders(): Promise<RemoteFolder[]> {
    return this.run("IMAP list", async () => {
      const client = await this.connection();
      const entries = await client.list({ statusQuery: { uidValidity: true } });
      return entries
        .filter((entry) => !entry.flags.has("\\Noselect") && !entry.flags.has("\\NonExistent"))
        .map((entry) => ({
          providerFolderId: entry.path,
          path: entry.path,
          name: entry.name,
          role: imapFolderRole(entry.specialUse, entry.path),
          uidValidity: entry.status?.uidValidity ?? null,
        }));
    });
  }

  async fetchChanges(request: FetchRequest): Promise<FetchResult> {
    return this.run("IMAP fetch", async () => {
      // A still-selected mailbox would be reused without a new EXAMINE (stale UIDVALIDITY/UIDNEXT).
      // Never deselect with CLOSE: in read-write mode it expunges \Deleted messages.
      if (this.client?.mailbox) await this.close();
      const client = await this.connection();
      const ctx: SyncContext = {
        request,
        remaining: Math.max(1, Math.floor(request.maxMessages)),
        changes: [],
        cursorResets: [],
        complete: true,
      };
      const cursors: Record<string, string> = { ...request.cursors };
      const uidValidity: Record<string, bigint> = {};
      for (const folder of request.folders) {
        if (ctx.remaining <= 0) {
          ctx.complete = false;
          break;
        }
        const key = imapCursorKey(folder.providerFolderId);
        const outcome = await this.syncFolder(client, folder, request.cursors[key], ctx);
        cursors[key] = outcome.cursor;
        if (outcome.uidValidity !== null) uidValidity[folder.providerFolderId] = outcome.uidValidity;
      }
      return { changes: ctx.changes, cursors, cursorResets: ctx.cursorResets, uidValidity, complete: ctx.complete };
    });
  }

  private decode(raw: string | undefined): DecodedCursor<{ cursor: FolderCursor; known: UidSet }> {
    const decoded = decodeCursor(raw, FolderCursor);
    if (decoded.status !== "ok") return decoded;
    const known = UidSet.parse(decoded.value.known);
    return known ? { status: "ok", value: { cursor: decoded.value, known } } : { status: "invalid" };
  }

  private emitRemoved(ctx: SyncContext, path: string, uidValidity: bigint, uids: Iterable<number>, known?: UidSet): void {
    for (const uid of uids) {
      known?.delete(uid);
      ctx.changes.push({
        kind: "location_removed",
        identityKey: null,
        location: { providerFolderId: path, uidValidity, uid: BigInt(uid), flags: [] },
      });
    }
  }

  private async syncFolder(
    client: ImapClient,
    folder: FetchFolder,
    raw: string | undefined,
    ctx: SyncContext,
  ): Promise<{ cursor: string; uidValidity: bigint | null }> {
    const path = folder.providerFolderId;
    const decoded = this.decode(raw);
    let lock: Awaited<ReturnType<ImapClient["getMailboxLock"]>>;
    try {
      lock = await client.getMailboxLock(path, { readOnly: true });
    } catch (err) {
      if ((err as { mailboxMissing?: boolean }).mailboxMissing) {
        // Tombstone instead of dropping the cursor (callers may keep the old one): UIDVALIDITY 0
        // never occurs in IMAP, so a recreated folder is re-imported via "uidvalidity_changed".
        const tombstone = decoded.status === "ok" && decoded.value.cursor.uv === "0";
        if (!tombstone) {
          if (decoded.status === "ok") {
            this.emitRemoved(ctx, path, BigInt(decoded.value.cursor.uv), decoded.value.known.sorted());
          }
          ctx.cursorResets.push({ providerFolderId: path, reason: "folder_missing" });
        }
        const cursor: FolderCursor = { v: 1, uv: "0", last: 0, known: "", ms: null, msTarget: null, fcAfter: 0, since: ctx.request.since.toISOString() };
        return { cursor: encodeCursor(cursor), uidValidity: null };
      }
      throw err;
    }
    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw connectorError(client.usable ? "server" : "network", "IMAP: folder could not be opened");
      const cursor = await this.syncSelected(client, folder, mailbox, decoded, ctx);
      // A cursor computed on a dropped connection could be based on empty answers.
      if (!client.usable) throw connectorError("network", "IMAP connection lost during sync");
      return { cursor: encodeCursor(cursor), uidValidity: mailbox.uidValidity };
    } finally {
      lock.release();
    }
  }

  private async syncSelected(
    client: ImapClient,
    folder: FetchFolder,
    mailbox: MailboxObject,
    decoded: DecodedCursor<{ cursor: FolderCursor; known: UidSet }>,
    ctx: SyncContext,
  ): Promise<FolderCursor> {
    const path = folder.providerFolderId;
    const uidValidity = mailbox.uidValidity;
    if (typeof uidValidity !== "bigint") throw connectorError("server", "IMAP server reported no UIDVALIDITY");
    let uidNextAtOpen: number | null = Number.isSafeInteger(mailbox.uidNext) && mailbox.uidNext > 0 ? mailbox.uidNext : null;
    if (uidNextAtOpen === null) {
      // Without UIDNEXT the highest existing UID marks the end of what this sync has seen.
      const highest = searchResult(await client.search({ uid: "*" }, { uid: true }), "IMAP fetch");
      uidNextAtOpen = (highest.length > 0 ? Math.max(...highest) : 0) + 1;
    }
    const condstore = client.enabled.has("CONDSTORE") && !mailbox.noModseq && mailbox.highestModseq !== undefined;
    const qresync = condstore && client.enabled.has("QRESYNC");
    const highestModseq = condstore ? (mailbox.highestModseq ?? null) : null;

    let cursor: FolderCursor;
    let known: UidSet;
    if (decoded.status === "ok" && decoded.value.cursor.uv === uidValidity.toString()) {
      cursor = { ...decoded.value.cursor };
      known = decoded.value.known;
    } else {
      if (decoded.status === "ok") {
        this.emitRemoved(ctx, path, BigInt(decoded.value.cursor.uv), decoded.value.known.sorted());
        ctx.cursorResets.push({ providerFolderId: path, reason: "uidvalidity_changed" });
      } else if (decoded.status === "invalid") {
        ctx.cursorResets.push({ providerFolderId: path, reason: "cursor_invalid" });
      } else if (folder.uidValidity !== null && folder.uidValidity !== uidValidity) {
        ctx.cursorResets.push({ providerFolderId: path, reason: "uidvalidity_changed" });
      }
      cursor = {
        v: 1,
        uv: uidValidity.toString(),
        last: 0,
        known: "",
        ms: highestModseq?.toString() ?? null,
        msTarget: null,
        fcAfter: 0,
        since: ctx.request.since.toISOString(),
      };
      known = new UidSet();
    }
    if (!condstore) {
      cursor.ms = null;
      cursor.msTarget = null;
      cursor.fcAfter = 0;
    }
    const ms = cursor.ms !== null ? BigInt(cursor.ms) : null;
    const scanFlags = ms !== null && highestModseq !== null && (cursor.msTarget !== null || highestModseq > ms);

    // 1. Expunges (and, with CONDSTORE, flag changes) among messages imported earlier.
    let changedUids: number[] = [];
    if (known.size > 0) {
      if (qresync && ms !== null) {
        const result = await this.changedSince(client, path, known, ms, true);
        this.emitRemoved(ctx, path, uidValidity, result.vanished, known);
        changedUids = result.changed;
      } else {
        const present = await this.presentUids(client, known);
        this.emitRemoved(ctx, path, uidValidity, known.sorted().filter((uid) => !present.has(uid)), known);
        if (scanFlags && ms !== null) changedUids = (await this.changedSince(client, path, known, ms, false)).changed;
      }
    }

    // 2. Flag changes: re-sent as upserts; resumable when the budget runs out.
    if (scanFlags && highestModseq !== null) {
      if (cursor.msTarget === null) {
        cursor.msTarget = highestModseq.toString();
        cursor.fcAfter = 0;
      }
      const pending = changedUids.filter((uid) => uid > cursor.fcAfter && known.has(uid)).sort(ascending);
      const processed = await this.importUids(client, path, uidValidity, pending, ctx, (uid) => {
        cursor.fcAfter = uid;
      });
      if (processed === pending.length) {
        cursor.ms = cursor.msTarget;
        cursor.msTarget = null;
        cursor.fcAfter = 0;
      } else {
        ctx.complete = false;
      }
    }

    // 3. New messages since the last handled UID (inside the window while an import is running).
    const query: SearchObject = { uid: `${cursor.last + 1}:*` };
    if (cursor.since) query.since = new Date(cursor.since);
    const found = searchResult(await client.search(query, { uid: true }), "IMAP fetch");
    // "n:*" also matches the highest UID when n is above it (RFC 3501 §6.4.8), so filter.
    const candidates = found.filter((uid) => uid > cursor.last).sort(ascending);
    const processed = await this.importUids(client, path, uidValidity, candidates, ctx, (uid, imported) => {
      if (imported) known.add(uid);
      cursor.last = Math.max(cursor.last, uid);
    });
    if (processed === candidates.length) {
      cursor.last = Math.max(cursor.last, uidNextAtOpen - 1);
      cursor.since = null;
      if (condstore && cursor.ms === null && highestModseq !== null) cursor.ms = highestModseq.toString();
    } else {
      ctx.complete = false;
    }
    cursor.known = this.encodeKnown(known);
    return cursor;
  }

  /** Never writes a cursor its own schema would reject; drops the oldest UIDs if necessary. */
  private encodeKnown(known: UidSet): string {
    let text = known.toString();
    if (known.size <= MAX_TRACKED_UIDS && text.length <= MAX_KNOWN_CHARS) return text;
    const sorted = known.sorted();
    let keep = Math.min(sorted.length, MAX_TRACKED_UIDS);
    text = toSequenceSet(sorted.slice(sorted.length - keep));
    while (text.length > MAX_KNOWN_CHARS && keep > 0) {
      keep = Math.floor(keep * 0.8);
      text = toSequenceSet(sorted.slice(sorted.length - keep));
    }
    this.logger.warn({ provider: "imap", dropped: sorted.length - keep }, "IMAP: oldest known UIDs no longer tracked for expunge detection");
    return text;
  }

  private async presentUids(client: ImapClient, known: UidSet): Promise<Set<number>> {
    const present = new Set<number>();
    for (const range of known.chunks()) {
      for (const uid of searchResult(await client.search({ uid: range }, { uid: true }), "IMAP fetch")) present.add(uid);
    }
    return present;
  }

  /** UID FETCH … (CHANGEDSINCE m [VANISHED]); VANISHED arrives as imapflow "expunge" events. */
  private async changedSince(
    client: ImapClient,
    path: string,
    known: UidSet,
    modseq: bigint,
    captureVanished: boolean,
  ): Promise<{ changed: number[]; vanished: number[] }> {
    const vanished = new Set<number>();
    const changed = new Set<number>();
    const onExpunge = (event: ExpungeEvent): void => {
      if (event.vanished && event.path === path && typeof event.uid === "number" && known.has(event.uid)) vanished.add(event.uid);
    };
    if (captureVanished) client.on("expunge", onExpunge);
    try {
      for (const range of known.chunks()) {
        const rows = await client.fetchAll(range, { uid: true, flags: true }, { uid: true, changedSince: modseq });
        for (const row of rows) if (typeof row.uid === "number" && known.has(row.uid)) changed.add(row.uid);
      }
    } finally {
      if (captureVanished) client.off("expunge", onExpunge);
    }
    return { changed: [...changed].filter((uid) => !vanished.has(uid)), vanished: [...vanished].sort(ascending) };
  }

  /** Fetches with BODY.PEEK[] (imapflow `source`) in an EXAMINEd folder, so \Seen is never set. */
  private async importUids(
    client: ImapClient,
    path: string,
    uidValidity: bigint,
    uids: number[],
    ctx: SyncContext,
    onDone: (uid: number, imported: boolean) => void,
  ): Promise<number> {
    const maxBytes = Math.max(1, Math.floor(ctx.request.maxMessageBytes));
    const chunkSize = Math.max(1, Math.min(25, Math.floor((32 * 1024 * 1024) / maxBytes)));
    let processed = 0;
    while (processed < uids.length && ctx.remaining > 0) {
      const batch = uids.slice(processed, processed + Math.min(chunkSize, ctx.remaining));
      const query = { uid: true, flags: true, internalDate: true, size: true, threadId: true, source: { maxLength: maxBytes + 1 } };
      const byUid = mergeRows(await client.fetchAll(batch.join(","), query, { uid: true }));
      for (const uid of batch) {
        let row = byUid.get(uid);
        if (row && !row.source) {
          // Retry once alone; importing a message without its body would store it empty.
          row = mergeRows(await client.fetchAll(String(uid), query, { uid: true })).get(uid);
          if (row && !row.source) throw connectorError("server", "IMAP server returned no message body");
        }
        if (row) {
          ctx.changes.push({ kind: "upsert", message: await this.normalize(row, path, uidValidity, maxBytes) });
          ctx.remaining -= 1;
        }
        onDone(uid, Boolean(row));
        processed += 1;
      }
    }
    return processed;
  }

  private async normalize(row: FetchMessageObject, path: string, uidValidity: bigint, maxBytes: number): Promise<NormalizedMessage> {
    const source = row.source ?? Buffer.alloc(0);
    const content = await processMime(source, {
      maxMessageBytes: maxBytes,
      sizeBytes: row.size ?? null,
      truncated: source.length > maxBytes,
    });
    const messageId = normalizeMessageId(content.rfcMessageId);
    return {
      identityKey: messageId ? `rfc:${messageId}` : `fp:${content.headersFingerprint}`,
      providerMessageId: row.emailId ?? null,
      providerThreadId: row.threadId ?? null,
      receivedAt: row.internalDate ? new Date(row.internalDate) : null,
      webLink: null,
      location: { providerFolderId: path, uidValidity, uid: BigInt(row.uid), flags: flagList(row.flags) },
      labels: [],
      ...content,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Markers

  async applyMarker(request: MarkerRequest, operation: "set" | "clear"): Promise<MarkerResult> {
    switch (request.strategy) {
      case "none":
        return { status: "applied", detail: "Keine Markierung konfiguriert" };
      case "imap_keyword":
      case "imap_flagged":
      case "imap_copy_folder":
        return this.run("IMAP marker", () => this.applyImapMarker(request, operation));
      default:
        return { status: "unsupported", detail: `Strategie ${request.strategy} gibt es für IMAP-Konten nicht` };
    }
  }

  private async applyImapMarker(request: MarkerRequest, operation: "set" | "clear"): Promise<MarkerResult> {
    const location = request.message.location;
    if (!location || location.uid === null) return { status: "failed", detail: "Ort der Nachricht (Ordner/UID) unbekannt" };
    const client = await this.connection();
    if (request.strategy === "imap_copy_folder") {
      if (isGmailImap(client)) {
        return { status: "unsupported", detail: "Bei Gmail über IMAP wäre die Kopie die Originalnachricht" };
      }
      return this.copyMarker(client, request, operation);
    }
    const flag = request.strategy === "imap_flagged" ? "\\Flagged" : request.keyword;
    if (
      !flag ||
      (request.strategy === "imap_keyword" &&
        (!KEYWORD_ATOM.test(flag) || flag.startsWith("\\") || flag.toLowerCase() === COPY_MARKER_KEYWORD.toLowerCase()))
    ) {
      return { status: "failed", detail: "Ungültiges oder fehlendes Schlagwort" };
    }
    const lock = await client.getMailboxLock(location.providerFolderId);
    try {
      const mailbox = client.mailbox;
      if (!mailbox) {
        if (!client.usable) throw connectorError("network", "IMAP connection lost");
        return { status: "failed", detail: "Ordner konnte nicht geöffnet werden" };
      }
      if (location.uidValidity !== null && mailbox.uidValidity !== location.uidValidity) {
        return { status: "failed", detail: "UIDVALIDITY des Ordners hat sich geändert; Nachricht neu einlesen" };
      }
      if (!allowsFlag(mailbox.permanentFlags, flag)) {
        return {
          status: "unsupported",
          detail: request.strategy === "imap_keyword" ? "Server erlaubt keine eigenen Schlagwörter" : "Server erlaubt \\Flagged nicht",
        };
      }
      const uid = location.uid.toString();
      const row = mergeRows(await client.fetchAll(uid, { uid: true, flags: true }, { uid: true })).get(Number(location.uid));
      if (!row) return { status: "failed", detail: "Nachricht ist nicht mehr im Ordner" };
      const has = row.flags?.has(flag) ?? false;
      if (operation === "set") {
        if (has) return { status: "applied", detail: "already_present" };
        const ok = await client.messageFlagsAdd(uid, [flag], { uid: true });
        return ok ? { status: "applied", detail: null } : { status: "failed", detail: "Server hat das Setzen abgelehnt" };
      }
      if (!has) return { status: "applied", detail: "not_present" };
      const ok = await client.messageFlagsRemove(uid, [flag], { uid: true });
      return ok ? { status: "applied", detail: null } : { status: "failed", detail: "Server hat das Entfernen abgelehnt" };
    } finally {
      lock.release();
    }
  }

  private async findCopies(client: ImapClient, folder: string, rfcMessageId: string): Promise<number[] | null> {
    let lock: Awaited<ReturnType<ImapClient["getMailboxLock"]>>;
    try {
      lock = await client.getMailboxLock(folder, { readOnly: true });
    } catch (err) {
      if ((err as { mailboxMissing?: boolean }).mailboxMissing) return null;
      throw err;
    }
    try {
      const query: SearchObject = { header: { "message-id": rfcMessageId } };
      return searchResult(await client.search(query, { uid: true }), "IMAP marker");
    } finally {
      lock.release();
    }
  }

  private async copyMarker(client: ImapClient, request: MarkerRequest, operation: "set" | "clear"): Promise<MarkerResult> {
    const target = request.folder;
    const location = request.message.location;
    if (!target) return { status: "failed", detail: "Zielordner für die Kopie fehlt" };
    if (!location || location.uid === null) return { status: "failed", detail: "Ort der Nachricht (Ordner/UID) unbekannt" };
    if (target === location.providerFolderId) return { status: "failed", detail: "Zielordner entspricht dem Quellordner" };
    const messageId = request.message.rfcMessageId;

    if (operation === "clear") {
      if (!client.capabilities.has("UIDPLUS")) {
        return { status: "unsupported", detail: "Server ohne UIDPLUS: Kopie kann nicht gezielt gelöscht werden" };
      }
      if (!messageId) return { status: "failed", detail: "Ohne Message-ID ist die Kopie nicht auffindbar" };
      let lock: Awaited<ReturnType<ImapClient["getMailboxLock"]>>;
      try {
        lock = await client.getMailboxLock(target);
      } catch (err) {
        if ((err as { mailboxMissing?: boolean }).mailboxMissing) return { status: "applied", detail: "not_present" };
        throw err;
      }
      try {
        // Search and delete in the same SELECT, so the UIDs cannot refer to a different mailbox state.
        const query: SearchObject = { header: { "message-id": messageId }, keyword: COPY_MARKER_KEYWORD };
        const own = searchResult(await client.search(query, { uid: true }), "IMAP marker");
        if (own.length === 0) return { status: "applied", detail: "not_present" };
        // Only messages carrying our copy keyword are deleted; UID EXPUNGE leaves anything else untouched.
        const ok = await client.messageDelete(own.join(","), { uid: true });
        return ok ? { status: "applied", detail: null } : { status: "failed", detail: "Server hat das Löschen der Kopie abgelehnt" };
      } finally {
        lock.release();
      }
    }

    if (messageId) {
      const existing = await this.findCopies(client, target, messageId);
      if (existing && existing.length > 0) return { status: "applied", detail: "already_present" };
    }
    const lock = await client.getMailboxLock(location.providerFolderId);
    let copiedUid: number | undefined;
    try {
      const mailbox = client.mailbox;
      if (!mailbox) {
        if (!client.usable) throw connectorError("network", "IMAP connection lost");
        return { status: "failed", detail: "Ordner konnte nicht geöffnet werden" };
      }
      if (location.uidValidity !== null && mailbox.uidValidity !== location.uidValidity) {
        return { status: "failed", detail: "UIDVALIDITY des Ordners hat sich geändert; Nachricht neu einlesen" };
      }
      const uid = location.uid.toString();
      let copied = await client.messageCopy(uid, target, { uid: true });
      if (!copied) {
        try {
          await client.mailboxCreate(target);
        } catch {
          // folder may exist already; the second COPY decides
        }
        copied = await client.messageCopy(uid, target, { uid: true });
      }
      if (!copied) return { status: "failed", detail: "Server hat das Kopieren abgelehnt" };
      copiedUid = copied.uidMap?.get(Number(location.uid));
    } finally {
      lock.release();
    }
    if (copiedUid === undefined) {
      return { status: "applied", detail: "Kopie angelegt, aber nicht gekennzeichnet (kein COPYUID); Aufheben nicht möglich" };
    }
    const targetLock = await client.getMailboxLock(target);
    try {
      const tagged = allowsFlag(client.mailbox ? client.mailbox.permanentFlags : undefined, COPY_MARKER_KEYWORD)
        ? await client.messageFlagsAdd(String(copiedUid), [COPY_MARKER_KEYWORD], { uid: true })
        : false;
      return { status: "applied", detail: tagged ? null : "Kopie angelegt, aber nicht gekennzeichnet; Aufheben nicht möglich" };
    } finally {
      targetLock.release();
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      if (client.usable) await client.logout();
    } catch {
      // logout is best effort
    } finally {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
  }
}

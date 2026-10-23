import type { AccountCapabilities, FolderRole, MarkerStrategy } from "@mailpilot/contracts";
import { z } from "zod";
import { normalizeMessageId, processMime } from "../content.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { connectorError } from "../errors.js";
import type {
  ConnectorError,
  FetchRequest,
  FetchResult,
  MailChange,
  MailConnector,
  MarkerRequest,
  MarkerResult,
  NormalizedMessage,
  ProviderKind,
  RemoteFolder,
} from "../types.js";

export interface FixtureFolderInput {
  providerFolderId: string;
  name?: string;
  path?: string;
  role?: FolderRole;
}

export interface FixtureMailboxOptions {
  /** Provider the fixture imitates (identity keys, cursor keys, capabilities). Default "imap". */
  provider?: ProviderKind;
  /** Default: INBOX (inbox) and Sent (sent). */
  folders?: FixtureFolderInput[];
  capabilities?: Partial<AccountCapabilities>;
  /** Default 5 MiB. */
  maxMessageBytes?: number;
}

export interface AddMessageOptions {
  flags?: string[];
  /** Server arrival time; defaults to the Date header or now. Decides the import window. */
  receivedAt?: Date;
}

export type FixtureOperation = "verify" | "listFolders" | "fetchChanges" | "applyMarker";

export interface FixtureMarkerOperation {
  at: Date;
  operation: "set" | "clear";
  request: MarkerRequest;
  result: MarkerResult;
}

interface FolderState {
  folder: RemoteFolder;
  uidValidity: bigint;
  uidNext: number;
}

interface Placement {
  uid: number;
  flags: Set<string>;
}

interface StoredMessage {
  template: NormalizedMessage;
  receivedAt: Date;
  labels: string[];
  placements: Map<string, Placement>;
}

type LogEntry =
  | { seq: number; kind: "upsert"; folderId: string; identityKey: string }
  | { seq: number; kind: "removed"; folderId: string; identityKey: string; uidValidity: bigint; uid: number }
  | { seq: number; kind: "deleted"; identityKey: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type LogInput = DistributiveOmit<LogEntry, "seq">;

const FolderCursor = z.object({
  v: z.literal(1),
  uv: z.string(),
  seq: z.number().int().min(0),
  /** Set while the window import of this folder is still running. */
  afterUid: z.number().int().min(0).nullable(),
  since: z.string().nullable(),
});
const AccountCursor = z.object({ v: z.literal(1), seq: z.number().int().min(0) });

const DEFAULT_MARKERS: Record<ProviderKind, MarkerStrategy[]> = {
  imap: ["none", "imap_keyword", "imap_flagged", "imap_copy_folder"],
  gmail: ["none", "gmail_label"],
  microsoft: ["none", "graph_category", "graph_flag"],
};

function defaultCapabilities(provider: ProviderKind): AccountCapabilities {
  return {
    incrementalSync: provider === "imap" ? "imap_uid" : provider === "gmail" ? "gmail_history" : "graph_delta",
    customKeywords: provider === "imap",
    flagged: provider !== "gmail",
    labels: provider === "gmail",
    categories: provider === "microsoft",
    copyToFolder: provider === "imap",
    webLinks: provider !== "imap",
    immutableIds: provider !== "imap",
    supportedMarkers: [...DEFAULT_MARKERS[provider]],
    notes: ["Testpostfach (Fixture) – keine echte Verbindung."],
  };
}

/**
 * In-memory mailbox with real cursor semantics: each fetch returns only what changed since the
 * cursor. Shared by any number of FixtureConnector instances (like a server).
 */
export class FixtureMailbox {
  readonly provider: ProviderKind;
  private readonly folderStates = new Map<string, FolderState>();
  private readonly messages = new Map<string, StoredMessage>();
  private readonly log: LogEntry[] = [];
  private seq = 0;
  private counter = 0;
  private capabilitiesValue: AccountCapabilities;
  private failure: { error: ConnectorError | Error; once: boolean; operations: FixtureOperation[] | null } | null = null;
  private readonly markerLog: FixtureMarkerOperation[] = [];
  readonly maxMessageBytes: number;

  constructor(options: FixtureMailboxOptions = {}) {
    this.provider = options.provider ?? "imap";
    this.capabilitiesValue = { ...defaultCapabilities(this.provider), ...options.capabilities };
    this.maxMessageBytes = options.maxMessageBytes ?? 5 * 1024 * 1024;
    const folders = options.folders ?? [
      { providerFolderId: "INBOX", role: "inbox" as const },
      { providerFolderId: "Sent", role: "sent" as const },
    ];
    for (const folder of folders) this.addFolder(folder);
  }

  addFolder(input: FixtureFolderInput): RemoteFolder {
    const name = input.name ?? input.providerFolderId;
    const folder: RemoteFolder = {
      providerFolderId: input.providerFolderId,
      path: input.path ?? name,
      name,
      role: input.role ?? (input.providerFolderId.toUpperCase() === "INBOX" ? "inbox" : "other"),
      uidValidity: this.provider === "imap" ? 1n : null,
    };
    this.folderStates.set(folder.providerFolderId, { folder, uidValidity: 1n, uidNext: 1 });
    return folder;
  }

  /** Removes a folder (and the message placements in it), like deleting it on the server. */
  removeFolder(folderId: string): void {
    this.state(folderId);
    for (const stored of this.messages.values()) this.unplace(stored, folderId);
    this.folderStates.delete(folderId);
  }

  get folders(): RemoteFolder[] {
    return [...this.folderStates.values()].map((state) => ({
      ...state.folder,
      uidValidity: this.provider === "imap" ? state.uidValidity : null,
    }));
  }

  get capabilities(): AccountCapabilities {
    return structuredClone(this.capabilitiesValue);
  }

  setCapabilities(capabilities: Partial<AccountCapabilities>): void {
    this.capabilitiesValue = { ...this.capabilitiesValue, ...capabilities };
  }

  /** Makes the next calls fail (all operations, or only the listed ones). `null` clears it. */
  setFailure(error: ConnectorError | Error | null, options: { once?: boolean; operations?: FixtureOperation[] } = {}): void {
    this.failure = error ? { error, once: options.once ?? false, operations: options.operations ?? null } : null;
  }

  /** @internal used by FixtureConnector */
  checkFailure(operation: FixtureOperation): void {
    const failure = this.failure;
    if (!failure || (failure.operations && !failure.operations.includes(operation))) return;
    if (failure.once) this.failure = null;
    throw failure.error;
  }

  get markerOperations(): readonly FixtureMarkerOperation[] {
    return this.markerLog;
  }

  /** @internal */
  recordMarker(entry: FixtureMarkerOperation): void {
    this.markerLog.push(entry);
  }

  private state(folderId: string): FolderState {
    const state = this.folderStates.get(folderId);
    if (!state) throw new Error(`Fixture folder ${folderId} does not exist`);
    return state;
  }

  private append(entry: LogInput): void {
    this.seq += 1;
    this.log.push({ ...entry, seq: this.seq } as LogEntry);
  }

  private place(stored: StoredMessage, folderId: string, flags: Iterable<string>): void {
    const state = this.state(folderId);
    stored.placements.set(folderId, { uid: state.uidNext, flags: new Set(flags) });
    state.uidNext += 1;
    this.append({ kind: "upsert", folderId, identityKey: stored.template.identityKey });
  }

  private unplace(stored: StoredMessage, folderId: string): void {
    const placement = stored.placements.get(folderId);
    if (!placement) return;
    stored.placements.delete(folderId);
    this.append({
      kind: "removed",
      folderId,
      identityKey: stored.template.identityKey,
      uidValidity: this.state(folderId).uidValidity,
      uid: placement.uid,
    });
  }

  /** Parses the raw message (processMime) and delivers it into the folder. */
  async addMessage(folderId: string, rawEml: string | Buffer, options: AddMessageOptions = {}): Promise<NormalizedMessage> {
    this.state(folderId);
    const content = await processMime(rawEml, { maxMessageBytes: this.maxMessageBytes });
    this.counter += 1;
    const messageId = normalizeMessageId(content.rfcMessageId);
    const providerId = `fx${this.counter.toString(16).padStart(6, "0")}`;
    const identityKey =
      this.provider === "imap"
        ? messageId
          ? `rfc:${messageId}`
          : `fp:${content.headersFingerprint}`
        : `${this.provider === "gmail" ? "gmail" : "graph"}:${providerId}`;
    let stored = this.messages.get(identityKey);
    if (!stored) {
      stored = {
        template: {
          identityKey,
          providerMessageId: this.provider === "imap" ? null : providerId,
          providerThreadId: null,
          receivedAt: options.receivedAt ?? content.sentAt ?? new Date(),
          webLink: this.provider === "imap" ? null : `https://mail.example.com/fixture/${providerId}`,
          location: null,
          labels: [],
          ...content,
        },
        receivedAt: options.receivedAt ?? content.sentAt ?? new Date(),
        labels: [],
        placements: new Map(),
      };
      this.messages.set(identityKey, stored);
    }
    this.unplace(stored, folderId);
    this.place(stored, folderId, options.flags ?? []);
    return this.snapshot(stored, folderId);
  }

  /** Moves the message out of every folder it is in into `toFolderId` (new UID there). */
  moveMessage(identityKey: string, toFolderId: string): void {
    const stored = this.require(identityKey);
    const flags = [...stored.placements.values()][0]?.flags ?? new Set<string>();
    for (const folderId of [...stored.placements.keys()]) this.unplace(stored, folderId);
    this.place(stored, toFolderId, flags);
  }

  /** Removes the message from the account entirely (reported as `deleted`). */
  deleteMessage(identityKey: string): void {
    const stored = this.require(identityKey);
    stored.placements.clear();
    this.messages.delete(identityKey);
    this.append({ kind: "deleted", identityKey });
  }

  /** Replaces the flags of the message in one folder (reported as upsert). */
  setFlags(identityKey: string, folderId: string, flags: string[]): void {
    const placement = this.require(identityKey).placements.get(folderId);
    if (!placement) throw new Error(`Fixture message ${identityKey} is not in ${folderId}`);
    placement.flags = new Set(flags);
    this.append({ kind: "upsert", folderId, identityKey });
  }

  /** Simulates a new UIDVALIDITY (e.g. folder recreated): all UIDs change, cursors become invalid. */
  changeUidValidity(folderId: string): void {
    const state = this.state(folderId);
    state.uidValidity += 1n;
    state.uidNext = 1;
    for (const stored of this.messages.values()) {
      const placement = stored.placements.get(folderId);
      if (placement) {
        placement.uid = state.uidNext;
        state.uidNext += 1;
      }
    }
  }

  getMessage(identityKey: string, folderId?: string): NormalizedMessage | null {
    const stored = this.messages.get(identityKey);
    if (!stored) return null;
    return this.snapshot(stored, folderId ?? [...stored.placements.keys()][0] ?? null);
  }

  listMessages(folderId?: string): NormalizedMessage[] {
    return [...this.messages.values()]
      .filter((stored) => !folderId || stored.placements.has(folderId))
      .map((stored) => this.snapshot(stored, folderId ?? [...stored.placements.keys()][0] ?? null));
  }

  private require(identityKey: string): StoredMessage {
    const stored = this.messages.get(identityKey);
    if (!stored) throw new Error(`Fixture message ${identityKey} does not exist`);
    return stored;
  }

  private snapshot(stored: StoredMessage, folderId: string | null): NormalizedMessage {
    const placement = folderId ? stored.placements.get(folderId) : undefined;
    const state = folderId ? this.folderStates.get(folderId) : undefined;
    return structuredClone({
      ...stored.template,
      labels: [...stored.labels],
      location:
        placement && folderId
          ? {
              providerFolderId: folderId,
              uidValidity: this.provider === "imap" ? (state?.uidValidity ?? null) : null,
              uid: this.provider === "imap" ? BigInt(placement.uid) : null,
              flags: [...placement.flags].sort(),
            }
          : null,
    });
  }

  /** @internal */
  fetch(request: FetchRequest): FetchResult {
    const prefix = this.provider;
    const changes: MailChange[] = [];
    const cursors: Record<string, string> = { ...request.cursors };
    const cursorResets: FetchResult["cursorResets"] = [];
    const uidValidity: Record<string, bigint> = {};
    let remaining = Math.max(1, Math.floor(request.maxMessages));
    let complete = true;

    const accountKey = `${prefix}:*`;
    const account = decodeCursor(request.cursors[accountKey], AccountCursor);
    const accountSeq = account.status === "ok" ? account.value.seq : this.seq;
    for (const entry of this.log) {
      if (entry.seq > accountSeq && entry.kind === "deleted") changes.push({ kind: "deleted", identityKey: entry.identityKey });
    }
    cursors[accountKey] = encodeCursor({ v: 1, seq: this.seq });

    for (const folder of request.folders) {
      const key = `${prefix}:${folder.providerFolderId}`;
      const state = this.folderStates.get(folder.providerFolderId);
      if (!state) {
        // Like the real connectors: report once and keep a tombstone cursor.
        const previous = decodeCursor(request.cursors[key], FolderCursor);
        if (!(previous.status === "ok" && previous.value.uv === "missing")) {
          cursorResets.push({ providerFolderId: folder.providerFolderId, reason: "folder_missing" });
        }
        cursors[key] = encodeCursor({ v: 1, uv: "missing", seq: this.seq, afterUid: null, since: null });
        continue;
      }
      if (this.provider === "imap") uidValidity[folder.providerFolderId] = state.uidValidity;
      if (remaining <= 0) {
        complete = false;
        continue;
      }
      const decoded = decodeCursor(request.cursors[key], FolderCursor);
      let cursor: z.infer<typeof FolderCursor>;
      if (decoded.status === "ok" && decoded.value.uv === state.uidValidity.toString()) {
        cursor = decoded.value;
      } else {
        if (decoded.status !== "missing") {
          cursorResets.push({
            providerFolderId: folder.providerFolderId,
            reason: decoded.status === "ok" ? "uidvalidity_changed" : "cursor_invalid",
          });
        }
        cursor = { v: 1, uv: state.uidValidity.toString(), seq: this.seq, afterUid: 0, since: request.since.toISOString() };
      }

      if (cursor.afterUid !== null) {
        const since = new Date(cursor.since ?? request.since.toISOString()).getTime();
        const pending = [...this.messages.values()]
          .map((stored) => ({ stored, placement: stored.placements.get(folder.providerFolderId) }))
          .filter((entry): entry is { stored: StoredMessage; placement: Placement } => entry.placement !== undefined)
          .filter((entry) => entry.placement.uid > (cursor.afterUid ?? 0) && entry.stored.receivedAt.getTime() >= since)
          .sort((a, b) => a.placement.uid - b.placement.uid);
        for (const entry of pending) {
          if (remaining <= 0) break;
          changes.push({ kind: "upsert", message: this.snapshot(entry.stored, folder.providerFolderId) });
          cursor.afterUid = entry.placement.uid;
          remaining -= 1;
        }
        if ((pending.at(-1)?.placement.uid ?? 0) <= (cursor.afterUid ?? 0)) {
          cursor.afterUid = null;
          cursor.since = null;
        } else {
          complete = false;
        }
      }

      if (cursor.afterUid === null) {
        let finished = true;
        for (const entry of this.log) {
          if (entry.seq <= cursor.seq) continue;
          if (entry.kind === "deleted" || entry.folderId !== folder.providerFolderId) continue;
          if (entry.kind === "removed") {
            changes.push({
              kind: "location_removed",
              identityKey: this.provider === "imap" ? null : entry.identityKey,
              location: {
                providerFolderId: entry.folderId,
                uidValidity: this.provider === "imap" ? entry.uidValidity : null,
                uid: this.provider === "imap" ? BigInt(entry.uid) : null,
                flags: [],
              },
            });
          } else {
            const stored = this.messages.get(entry.identityKey);
            if (stored?.placements.has(folder.providerFolderId)) {
              if (remaining <= 0) {
                finished = false;
                break;
              }
              changes.push({ kind: "upsert", message: this.snapshot(stored, folder.providerFolderId) });
              remaining -= 1;
            }
          }
          cursor.seq = entry.seq;
        }
        if (finished) cursor.seq = this.seq;
        else complete = false;
      }
      cursors[key] = encodeCursor(cursor);
    }
    return { changes, cursors, cursorResets, uidValidity, complete };
  }

  private find(request: MarkerRequest): StoredMessage | null {
    const { location, providerMessageId, rfcMessageId } = request.message;
    for (const stored of this.messages.values()) {
      if (location?.uid !== null && location?.uid !== undefined) {
        const placement = stored.placements.get(location.providerFolderId);
        if (placement && BigInt(placement.uid) === location.uid) return stored;
        continue;
      }
      if (providerMessageId && stored.template.providerMessageId === providerMessageId) return stored;
      if (!providerMessageId && rfcMessageId && stored.template.rfcMessageId === rfcMessageId) return stored;
    }
    return null;
  }

  /** @internal */
  applyMarker(request: MarkerRequest, operation: "set" | "clear"): MarkerResult {
    if (!this.capabilitiesValue.supportedMarkers.includes(request.strategy)) {
      return { status: "unsupported", detail: `Strategie ${request.strategy} wird nicht unterstützt` };
    }
    if (request.strategy === "none") return { status: "applied", detail: "Keine Markierung konfiguriert" };
    const stored = this.find(request);
    if (!stored) return { status: "failed", detail: "Nachricht nicht gefunden" };
    const folderId = request.message.location?.providerFolderId ?? [...stored.placements.keys()][0];
    const placement = folderId ? stored.placements.get(folderId) : undefined;
    const toggle = (present: boolean, change: () => void): MarkerResult => {
      if (operation === "set" && present) return { status: "applied", detail: "already_present" };
      if (operation === "clear" && !present) return { status: "applied", detail: "not_present" };
      change();
      if (folderId && placement) this.append({ kind: "upsert", folderId, identityKey: stored.template.identityKey });
      return { status: "applied", detail: null };
    };
    switch (request.strategy) {
      case "imap_keyword":
      case "imap_flagged":
      case "graph_flag": {
        const flag = request.strategy === "imap_keyword" ? request.keyword : "\\Flagged";
        if (!flag) return { status: "failed", detail: "Schlagwort fehlt" };
        if (!placement) return { status: "failed", detail: "Nachricht nicht im Ordner" };
        return toggle(placement.flags.has(flag), () => {
          if (operation === "set") placement.flags.add(flag);
          else placement.flags.delete(flag);
        });
      }
      case "gmail_label":
      case "graph_category": {
        const name = request.keyword?.trim() || "MailPilot";
        return toggle(stored.labels.includes(name), () => {
          stored.labels = operation === "set" ? [...stored.labels, name] : stored.labels.filter((label) => label !== name);
        });
      }
      case "imap_copy_folder": {
        const target = request.folder;
        if (!target) return { status: "failed", detail: "Zielordner fehlt" };
        if (!this.folderStates.has(target)) this.addFolder({ providerFolderId: target });
        if (operation === "set") {
          if (stored.placements.has(target)) return { status: "applied", detail: "already_present" };
          this.place(stored, target, placement?.flags ?? []);
        } else {
          if (!stored.placements.has(target)) return { status: "applied", detail: "not_present" };
          this.unplace(stored, target);
        }
        return { status: "applied", detail: null };
      }
      default:
        return { status: "unsupported", detail: `Strategie ${request.strategy} wird nicht unterstützt` };
    }
  }
}

/** MailConnector over a FixtureMailbox; for worker tests without any network. */
export class FixtureConnector implements MailConnector {
  readonly provider: ProviderKind;
  closed = false;

  constructor(readonly mailbox: FixtureMailbox) {
    this.provider = mailbox.provider;
  }

  get markerOperations(): readonly FixtureMarkerOperation[] {
    return this.mailbox.markerOperations;
  }

  async verify(): Promise<AccountCapabilities> {
    this.mailbox.checkFailure("verify");
    return this.mailbox.capabilities;
  }

  async listFolders(): Promise<RemoteFolder[]> {
    this.mailbox.checkFailure("listFolders");
    return this.mailbox.folders;
  }

  async fetchChanges(request: FetchRequest): Promise<FetchResult> {
    this.mailbox.checkFailure("fetchChanges");
    return this.mailbox.fetch(request);
  }

  async applyMarker(request: MarkerRequest, operation: "set" | "clear"): Promise<MarkerResult> {
    this.mailbox.checkFailure("applyMarker");
    const result = this.mailbox.applyMarker(request, operation);
    this.mailbox.recordMarker({ at: new Date(), operation, request: structuredClone(request), result });
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Convenience for tests: a ConnectorError like the real connectors throw. */
export function fixtureError(code: ConnectorError["code"], userAction?: string): ConnectorError {
  return connectorError(code, `fixture: ${code}`, userAction ? { userAction } : {});
}

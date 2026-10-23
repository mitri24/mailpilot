import { EventEmitter } from "node:events";
import type { FetchMessageObject, FetchOptions, FetchQueryObject, ImapFlowOptions, ListResponse, MailboxObject, SearchObject } from "imapflow";
import type { ImapClient, ImapClientFactory } from "../../src/index.js";

interface FakeMessage {
  uid: number;
  flags: Set<string>;
  modseq: bigint;
  raw: string;
  internalDate: Date;
}

interface FakeMailbox {
  path: string;
  specialUse?: string;
  uidValidity: bigint;
  uidNext: number;
  highestModseq: bigint;
  messages: Map<number, FakeMessage>;
  expunged: Array<{ uid: number; modseq: bigint }>;
  permanentFlags?: Set<string>;
}

export interface FakeCall {
  method: string;
  args: unknown[];
}

/** In-memory IMAP server model with CONDSTORE/QRESYNC semantics, used through FakeImapClient. */
export class FakeImapServer {
  readonly mailboxes = new Map<string, FakeMailbox>();
  readonly capabilities = new Map<string, boolean | number>([
    ["IMAP4rev1", true],
    ["UIDPLUS", true],
    ["MOVE", true],
  ]);
  /** Extensions the server lets the client ENABLE. */
  readonly enableable = new Set<string>();
  readonly calls: FakeCall[] = [];
  readonly clientOptions: ImapFlowOptions[] = [];
  authFail = false;
  /** Emits an extra unsolicited FLAGS-only row after every fetched row (servers may do that). */
  interleaveRows = false;
  /** Leaves UIDNEXT out of the SELECT/EXAMINE answer. */
  omitUidNext = false;
  /** Called on every getMailboxLock; tests use it to drop connections mid-sync. */
  onLock: (() => void) | null = null;
  /** Called before every SEARCH (one-shot). */
  onSearch: (() => void) | null = null;
  readonly clients: FakeImapClient[] = [];
  private modseq = 100n;

  addMailbox(path: string, options: { specialUse?: string; permanentFlags?: string[]; uidValidity?: bigint } = {}): FakeMailbox {
    const mailbox: FakeMailbox = {
      path,
      ...(options.specialUse ? { specialUse: options.specialUse } : {}),
      uidValidity: options.uidValidity ?? 1000n,
      uidNext: 1,
      highestModseq: this.modseq,
      messages: new Map(),
      expunged: [],
      ...(options.permanentFlags ? { permanentFlags: new Set(options.permanentFlags) } : {}),
    };
    this.mailboxes.set(path, mailbox);
    return mailbox;
  }

  private bump(mailbox: FakeMailbox): bigint {
    this.modseq += 1n;
    mailbox.highestModseq = this.modseq;
    return this.modseq;
  }

  box(path: string): FakeMailbox {
    const mailbox = this.mailboxes.get(path);
    if (!mailbox) throw new Error(`no mailbox ${path}`);
    return mailbox;
  }

  append(path: string, raw: string, options: { flags?: string[]; internalDate?: Date } = {}): number {
    const mailbox = this.box(path);
    const uid = mailbox.uidNext++;
    mailbox.messages.set(uid, {
      uid,
      flags: new Set(options.flags ?? []),
      modseq: this.bump(mailbox),
      raw,
      internalDate: options.internalDate ?? new Date(),
    });
    return uid;
  }

  setFlags(path: string, uid: number, flags: string[]): void {
    const mailbox = this.box(path);
    const message = mailbox.messages.get(uid);
    if (!message) throw new Error(`no uid ${uid}`);
    message.flags = new Set(flags);
    message.modseq = this.bump(mailbox);
  }

  expunge(path: string, uid: number): void {
    const mailbox = this.box(path);
    mailbox.messages.delete(uid);
    mailbox.expunged.push({ uid, modseq: this.bump(mailbox) });
  }

  /** Folder recreated: new UIDVALIDITY, messages renumbered from 1. */
  resetUidValidity(path: string): void {
    const mailbox = this.box(path);
    mailbox.uidValidity += 1n;
    const messages = [...mailbox.messages.values()].sort((a, b) => a.uid - b.uid);
    mailbox.messages.clear();
    mailbox.expunged = [];
    mailbox.uidNext = 1;
    for (const message of messages) {
      message.uid = mailbox.uidNext++;
      mailbox.messages.set(message.uid, message);
    }
  }

  factory(): ImapClientFactory {
    return (options) => {
      this.clientOptions.push(options);
      const client = new FakeImapClient(this, options);
      this.clients.push(client);
      return client as unknown as ImapClient;
    };
  }

  /** Like a server BYE: imapflow then clears `mailbox` and SEARCH resolves with undefined. */
  dropConnections(): void {
    for (const client of this.clients) client.drop();
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

function parseRange(range: string, mailbox: FakeMailbox): number[] {
  const max = Math.max(0, ...mailbox.messages.keys());
  const out = new Set<number>();
  for (const part of range.split(",")) {
    const [startText, endText] = part.split(":");
    const start = startText === "*" ? max : Number(startText);
    const end = endText === undefined ? start : endText === "*" ? max : Number(endText);
    const [low, high] = start <= end ? [start, end] : [end, start];
    for (let uid = low; uid <= high; uid++) out.add(uid);
  }
  return [...out].sort((a, b) => a - b);
}

class FakeImapClient extends EventEmitter {
  usable = false;
  mailbox: MailboxObject | false = false;
  capabilities = new Map<string, boolean | number>();
  enabled = new Set<string>();

  constructor(
    private readonly server: FakeImapServer,
    private readonly options: ImapFlowOptions,
  ) {
    super();
  }

  private record(method: string, ...args: unknown[]): void {
    this.server.calls.push({ method, args });
  }

  async connect(): Promise<void> {
    this.record("connect");
    if (this.server.authFail) {
      throw Object.assign(new Error("Authentication failed."), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    }
    this.capabilities = new Map(this.server.capabilities);
    this.enabled = new Set([...this.server.enableable].filter((ext) => ext !== "QRESYNC" || this.options.qresync));
    this.usable = true;
  }

  async logout(): Promise<void> {
    this.record("logout");
    this.usable = false;
    this.mailbox = false;
  }

  close(): void {
    this.usable = false;
    this.mailbox = false;
  }

  drop(): void {
    this.usable = false;
    this.mailbox = false;
  }

  async list(): Promise<ListResponse[]> {
    this.record("list");
    return [...this.server.mailboxes.values()].map((mailbox) => ({
      path: mailbox.path,
      pathAsListed: mailbox.path,
      name: mailbox.path.split("/").pop() ?? mailbox.path,
      delimiter: "/",
      parent: [],
      parentPath: "",
      flags: new Set<string>(),
      ...(mailbox.specialUse ? { specialUse: mailbox.specialUse } : {}),
      listed: true,
      subscribed: true,
      status: { path: mailbox.path, uidValidity: mailbox.uidValidity },
    }));
  }

  async getMailboxLock(path: string, options: { readOnly?: boolean } = {}): Promise<{ path: string; release: () => void }> {
    this.record("getMailboxLock", path, options);
    const mailbox = this.server.mailboxes.get(path);
    const hook = this.server.onLock;
    this.server.onLock = null;
    if (!mailbox) throw Object.assign(new Error("Mailbox does not exist"), { mailboxMissing: true, responseStatus: "NO" });
    const condstore = this.enabled.has("CONDSTORE");
    this.mailbox = {
      path,
      delimiter: "/",
      flags: new Set(["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft"]),
      ...(mailbox.permanentFlags ? { permanentFlags: new Set(mailbox.permanentFlags) } : {}),
      uidValidity: mailbox.uidValidity,
      uidNext: this.server.omitUidNext ? (undefined as unknown as number) : mailbox.uidNext,
      exists: mailbox.messages.size,
      ...(condstore ? { highestModseq: mailbox.highestModseq } : {}),
      readOnly: options.readOnly ?? false,
    };
    hook?.();
    return { path, release: () => undefined };
  }

  private current(): FakeMailbox {
    if (!this.mailbox) throw Object.assign(new Error("No mailbox selected"), { code: "NoMailboxSelected" });
    return this.server.box(this.mailbox.path);
  }

  async search(query: SearchObject, options: { uid?: boolean } = {}): Promise<number[] | false | undefined> {
    this.record("search", query, options);
    const hook = this.server.onSearch;
    this.server.onSearch = null;
    hook?.();
    if (!this.mailbox) return undefined;
    const mailbox = this.current();
    let uids = [...mailbox.messages.keys()];
    if (query.uid !== undefined) {
      const allowed = new Set(parseRange(String(query.uid), mailbox));
      uids = uids.filter((uid) => allowed.has(uid));
    }
    if (query.since) {
      const since = new Date(query.since).setUTCHours(0, 0, 0, 0);
      uids = uids.filter((uid) => (mailbox.messages.get(uid)?.internalDate.getTime() ?? 0) >= since);
    }
    if (query.keyword) uids = uids.filter((uid) => mailbox.messages.get(uid)?.flags.has(query.keyword as string));
    const messageId = query.header?.["message-id"];
    if (typeof messageId === "string") uids = uids.filter((uid) => mailbox.messages.get(uid)?.raw.includes(messageId));
    return uids.sort((a, b) => a - b);
  }

  async fetchAll(range: string, query: FetchQueryObject, options: FetchOptions = {}): Promise<FetchMessageObject[]> {
    this.record("fetchAll", range, query, options);
    const mailbox = this.current();
    const uids = parseRange(String(range), mailbox);
    const changedSince = options.changedSince !== undefined ? BigInt(options.changedSince) : null;
    if (changedSince !== null && options.uid && this.enabled.has("QRESYNC")) {
      const requested = new Set(uids);
      const vanished = mailbox.expunged.filter((entry) => entry.modseq > changedSince && requested.has(entry.uid));
      for (const entry of vanished) this.emit("expunge", { path: mailbox.path, uid: entry.uid, vanished: true, earlier: true });
    }
    const rows: FetchMessageObject[] = [];
    for (const uid of uids) {
      const message = mailbox.messages.get(uid);
      if (!message) continue;
      if (changedSince !== null && message.modseq <= changedSince) continue;
      const source = Buffer.from(message.raw, "utf8");
      const maxLength = typeof query.source === "object" ? query.source.maxLength : undefined;
      rows.push({
        seq: uid,
        uid,
        flags: new Set(message.flags),
        modseq: message.modseq,
        internalDate: message.internalDate,
        size: source.length,
        ...(query.source ? { source: maxLength ? source.subarray(0, maxLength) : source } : {}),
      });
      if (this.server.interleaveRows) rows.push({ seq: uid, uid, flags: new Set(["\\Seen", "\\Answered"]) });
    }
    return rows;
  }

  async messageFlagsAdd(range: string, flags: string[], options: { uid?: boolean } = {}): Promise<boolean> {
    this.record("messageFlagsAdd", range, flags, options);
    if (!this.mailbox || this.mailbox.readOnly) return false;
    const mailbox = this.current();
    for (const uid of parseRange(range, mailbox)) {
      const message = mailbox.messages.get(uid);
      if (message) this.server.setFlags(mailbox.path, uid, [...message.flags, ...flags]);
    }
    return true;
  }

  async messageFlagsRemove(range: string, flags: string[], options: { uid?: boolean } = {}): Promise<boolean> {
    this.record("messageFlagsRemove", range, flags, options);
    if (!this.mailbox || this.mailbox.readOnly) return false;
    const mailbox = this.current();
    for (const uid of parseRange(range, mailbox)) {
      const message = mailbox.messages.get(uid);
      if (message) this.server.setFlags(mailbox.path, uid, [...message.flags].filter((flag) => !flags.includes(flag)));
    }
    return true;
  }

  async messageCopy(range: string, destination: string, options: { uid?: boolean } = {}): Promise<{ path: string; destination: string; uidMap: Map<number, number> } | false> {
    this.record("messageCopy", range, destination, options);
    const target = this.server.mailboxes.get(destination);
    if (!target) return false;
    const mailbox = this.current();
    const uidMap = new Map<number, number>();
    for (const uid of parseRange(range, mailbox)) {
      const message = mailbox.messages.get(uid);
      if (message) uidMap.set(uid, this.server.append(destination, message.raw, { flags: [...message.flags], internalDate: message.internalDate }));
    }
    return { path: mailbox.path, destination, uidMap };
  }

  async messageDelete(range: string, options: { uid?: boolean } = {}): Promise<boolean> {
    this.record("messageDelete", range, options);
    const mailbox = this.current();
    for (const uid of parseRange(range, mailbox)) this.server.expunge(mailbox.path, uid);
    return true;
  }

  async mailboxCreate(path: string): Promise<{ path: string; created: boolean }> {
    this.record("mailboxCreate", path);
    if (!this.server.mailboxes.has(path)) this.server.addMailbox(path);
    return { path, created: true };
  }
}

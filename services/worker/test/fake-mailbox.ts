import { createHash } from "node:crypto";
import type { AccountCapabilities } from "@mailpilot/contracts";
import {
  ConnectorError,
  type FetchRequest,
  type FetchResult,
  type MailChange,
  type MailConnector,
  type MarkerRequest,
  type MarkerResult,
  type NormalizedMessage,
  type RemoteFolder,
} from "@mailpilot/mail-connectors";

export interface FakeMail {
  rfcMessageId: string;
  from: string;
  fromName?: string;
  to?: string[];
  subject: string;
  text: string;
  sentAt: Date;
  inReplyTo?: string;
  attachments?: Array<{ filename: string; contentType: string; size: number }>;
}

interface Stored {
  mail: FakeMail;
  uid: bigint;
  flags: string[];
}

/** In-memory IMAP-like mailbox: UIDs per folder, moves change locations, nothing is marked as read. */
export class FakeMailbox {
  readonly folders = new Map<string, { role: RemoteFolder["role"]; uidValidity: bigint; nextUid: bigint; messages: Stored[] }>();
  readonly markerCalls: Array<{ request: MarkerRequest; op: "set" | "clear" }> = [];
  readonly removals: Array<{ folder: string; uid: bigint }> = [];
  failNext: ConnectorError | null = null;

  constructor(readonly capabilities: AccountCapabilities) {
    this.addFolder("INBOX", "inbox");
    this.addFolder("Sent", "sent");
    this.addFolder("Junk", "spam");
    this.addFolder("Archiv", "archive");
  }

  addFolder(path: string, role: RemoteFolder["role"]) {
    this.folders.set(path, { role, uidValidity: 1000n, nextUid: 1n, messages: [] });
  }

  deliver(folder: string, mail: FakeMail): bigint {
    const f = this.folders.get(folder)!;
    const uid = f.nextUid++;
    f.messages.push({ mail, uid, flags: [] });
    return uid;
  }

  move(rfcMessageId: string, from: string, to: string) {
    const src = this.folders.get(from)!;
    const idx = src.messages.findIndex((m) => m.mail.rfcMessageId === rfcMessageId);
    const [stored] = src.messages.splice(idx, 1);
    this.removals.push({ folder: from, uid: stored!.uid });
    this.deliver(to, stored!.mail);
  }

  connector(): MailConnector {
    return new FakeConnector(this);
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

class FakeConnector implements MailConnector {
  readonly provider = "imap" as const;
  constructor(private readonly box: FakeMailbox) {}

  private check() {
    if (this.box.failNext) {
      const e = this.box.failNext;
      this.box.failNext = null;
      throw e;
    }
  }

  async verify() {
    this.check();
    return this.box.capabilities;
  }

  async listFolders(): Promise<RemoteFolder[]> {
    this.check();
    return [...this.box.folders.entries()].map(([path, f]) => ({ providerFolderId: path, path, name: path, role: f.role, uidValidity: f.uidValidity }));
  }

  async fetchChanges(request: FetchRequest): Promise<FetchResult> {
    this.check();
    const changes: MailChange[] = [];
    const cursors: Record<string, string> = { ...request.cursors };
    for (const folder of request.folders) {
      const f = this.box.folders.get(folder.providerFolderId);
      if (!f) continue;
      const key = `uid:${folder.providerFolderId}`;
      const last = BigInt(request.cursors[key] ?? "0");
      for (const s of f.messages.filter((m) => m.uid > last && m.mail.sentAt >= request.since)) {
        changes.push({ kind: "upsert", message: this.normalize(s, folder.providerFolderId, f.uidValidity) });
      }
      cursors[key] = String(f.nextUid - 1n);
    }
    for (const r of this.box.removals.splice(0)) {
      if (request.folders.some((f) => f.providerFolderId === r.folder)) {
        changes.push({ kind: "location_removed", identityKey: null, location: { providerFolderId: r.folder, uidValidity: 1000n, uid: r.uid, flags: [] } });
      }
    }
    return { changes, cursors, cursorResets: [], uidValidity: {}, complete: true };
  }

  private normalize(s: Stored, folder: string, uidValidity: bigint): NormalizedMessage {
    const m = s.mail;
    return {
      identityKey: `rfc:${m.rfcMessageId}`,
      providerMessageId: null,
      providerThreadId: null,
      rfcMessageId: m.rfcMessageId,
      inReplyTo: m.inReplyTo ?? null,
      references: m.inReplyTo ? [m.inReplyTo] : [],
      from: { name: m.fromName ?? null, address: m.from },
      to: (m.to ?? []).map((address) => ({ name: null, address })),
      cc: [],
      subject: m.subject,
      sentAt: m.sentAt,
      receivedAt: m.sentAt,
      bodyText: m.text,
      bodyHtmlSanitized: null,
      remoteContentBlocked: 0,
      snippet: m.text.slice(0, 120),
      attachments: (m.attachments ?? []).map((a) => ({ ...a, inline: false })),
      sizeBytes: m.text.length,
      contentHash: sha(`${m.subject}\n${m.text}`),
      headersFingerprint: sha(`${m.from}|${m.sentAt.toISOString()}|${m.subject}|${m.rfcMessageId}`),
      webLink: null,
      location: { providerFolderId: folder, uidValidity, uid: s.uid, flags: s.flags },
      labels: [],
      truncated: false,
    };
  }

  async applyMarker(request: MarkerRequest, op: "set" | "clear"): Promise<MarkerResult> {
    this.check();
    this.box.markerCalls.push({ request, op });
    if (request.strategy === "imap_keyword" && !this.box.capabilities.customKeywords) return { status: "unsupported", detail: "Keine eigenen Schlüsselwörter" };
    return { status: "applied", detail: null };
  }

  async close() {}
}

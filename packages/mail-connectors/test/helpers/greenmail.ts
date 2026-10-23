import net from "node:net";
import { ImapFlow } from "imapflow";
import type { ImapClientFactory } from "../../src/index.js";
import type { ConnectorAccount } from "../../src/types.js";

/** Local GreenMail from infra/docker-compose.yml (profile "test"); never a real mailbox. */
export const GREENMAIL_HOST = process.env.GREENMAIL_HOST ?? "127.0.0.1";
export const IMAPS_PORT = 3993;
export const IMAP_PORT = 3143;
export const SMTP_PORT = 3025;
/** GreenMail ships a self-signed certificate; tests inject this via `imapTls`. */
export const TEST_TLS = { rejectUnauthorized: false } as const;

export const USERS = {
  alice: { user: "alice@example.com", pass: "alice-pass" },
  bob: { user: "bob@example.com", pass: "bob-pass" },
  carol: { user: "carol@example.com", pass: "carol-pass" },
  dave: { user: "dave@example.com", pass: "dave-pass" },
  erin: { user: "erin@example.com", pass: "erin-pass" },
  frank: { user: "frank@example.com", pass: "frank-pass" },
} as const;
export interface TestUser {
  user: string;
  pass: string;
}

export function greenmailReachable(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: GREENMAIL_HOST, port: IMAPS_PORT });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function imapAccount(
  user: TestUser,
  overrides: Partial<Extract<ConnectorAccount, { provider: "imap" }>["imap"]> = {},
): Extract<ConnectorAccount, { provider: "imap" }> {
  return {
    provider: "imap",
    emailAddress: user.user,
    imap: { host: GREENMAIL_HOST, port: IMAPS_PORT, secure: true, username: user.user, password: user.pass, ...overrides },
  };
}

/** Independent client playing "the user in Apple Mail" (appends, moves, checks flags). */
export async function withUserClient<T>(user: TestUser, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: GREENMAIL_HOST,
    port: IMAPS_PORT,
    secure: true,
    tls: TEST_TLS,
    auth: { user: user.user, pass: user.pass },
    logger: false,
    disableAutoIdle: true,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * Empties every folder of the user. Folders are not deleted: GreenMail 2.1.3 throws a
 * NullPointerException (ImapSessionFolder.mailboxDeleted) when a folder is deleted that an
 * already closed session had selected, and drops the deleting connection.
 */
export async function resetMailbox(user: TestUser): Promise<void> {
  await withUserClient(user, async (client) => {
    for (const box of await client.list()) {
      const lock = await client.getMailboxLock(box.path);
      try {
        if (client.mailbox && client.mailbox.exists > 0) await client.messageDelete("1:*");
      } finally {
        lock.release();
      }
    }
  });
}

export async function ensureFolders(client: ImapFlow, paths: string[]): Promise<void> {
  const existing = new Set((await client.list()).map((box) => box.path));
  for (const path of paths) if (!existing.has(path)) await client.mailboxCreate(path);
}

/** Folder names that are deleted during a test are unique per run (see resetMailbox). */
export const RUN_ID = Date.now().toString(36);

export async function folderFlags(user: TestUser, path: string): Promise<Array<{ uid: number; messageId: string | undefined; flags: string[] }>> {
  return withUserClient(user, async (client) => {
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      if (!client.mailbox || client.mailbox.exists === 0) return [];
      const rows = await client.fetchAll("1:*", { uid: true, flags: true, envelope: true }, { uid: true });
      return rows.map((row) => ({ uid: row.uid, messageId: row.envelope?.messageId, flags: [...(row.flags ?? [])].sort() }));
    } finally {
      lock.release();
    }
  });
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function eml(options: { id: string; subject: string; date?: Date; from?: string; to?: string; body?: string }): string {
  return [
    `From: ${options.from ?? "Max Muster <max@example.org>"}`,
    `To: ${options.to ?? "Test <test@example.com>"}`,
    `Subject: ${options.subject}`,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${options.id}@example.org>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    options.body ?? `Hallo,\r\nbitte bis Freitag das Angebot ${options.id} prüfen.\r\n\r\nViele Grüße\r\nMax`,
    "",
  ].join("\r\n");
}

/** Records every IMAP command the connector sends (imapflow logs them at debug level). */
export function recordingClientFactory(commands: string[]): ImapClientFactory {
  return (options) =>
    new ImapFlow({
      ...options,
      logger: {
        debug: (entry: { src?: string; msg?: string }) => {
          if (entry?.src === "c" && typeof entry.msg === "string") commands.push(entry.msg);
        },
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
}

/** Minimal SMTP client (RFC 5321) for delivering a test message to GreenMail. */
export async function sendSmtp(from: string, to: string, raw: string): Promise<void> {
  const socket = net.connect({ host: GREENMAIL_HOST, port: SMTP_PORT });
  socket.setEncoding("utf8");
  let buffer = "";
  const waiters: Array<(line: string) => void> = [];
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      // Multi-line replies use "250-"; only the final "250 " line completes a reply.
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) waiters.shift()?.(line);
    }
  });
  const reply = (): Promise<string> => new Promise((resolve) => waiters.push(resolve));
  const expectCode = async (code: string): Promise<void> => {
    const line = await reply();
    if (!line.startsWith(code)) throw new Error(`SMTP expected ${code}, got ${line}`);
  };
  const send = (line: string): void => {
    socket.write(`${line}\r\n`);
  };
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  await expectCode("220");
  send("EHLO mailpilot.test");
  await expectCode("250");
  send(`MAIL FROM:<${from}>`);
  await expectCode("250");
  send(`RCPT TO:<${to}>`);
  await expectCode("250");
  send("DATA");
  await expectCode("354");
  const body = raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  socket.write(`${body.endsWith("\r\n") ? body : `${body}\r\n`}.\r\n`);
  await expectCode("250");
  send("QUIT");
  await expectCode("221");
  socket.end();
}

import { ImapFlow, type ImapFlowOptions, type Logger } from "imapflow";
import type { ConnectorLogger } from "../logger.js";

/** The part of ImapFlow the connector uses; a seam for unit tests with a fake client. */
export type ImapClient = Pick<
  ImapFlow,
  | "capabilities"
  | "enabled"
  | "mailbox"
  | "usable"
  | "connect"
  | "logout"
  | "close"
  | "list"
  | "getMailboxLock"
  | "search"
  | "fetchAll"
  | "messageFlagsAdd"
  | "messageFlagsRemove"
  | "messageCopy"
  | "messageDelete"
  | "mailboxCreate"
  | "on"
  | "off"
>;

export type ImapClientFactory = (options: ImapFlowOptions) => ImapClient;

export const createImapFlowClient: ImapClientFactory = (options) => new ImapFlow(options);

/** imapflow logs commands and responses at debug level; only warnings and errors are forwarded, without payloads. */
export function imapflowLogger(logger: ConnectorLogger): Logger {
  const forward = (level: "warn" | "error") => (entry: unknown) => {
    const record = (entry && typeof entry === "object" ? entry : {}) as { msg?: unknown; cid?: unknown; err?: { code?: unknown } };
    logger[level](
      { component: "imapflow", cid: record.cid, code: record.err?.code },
      typeof record.msg === "string" ? record.msg : "imapflow",
    );
  };
  // trace/fatal are given explicitly: imapflow falls back to console.error for missing levels.
  return { trace: () => {}, debug: () => {}, info: () => {}, warn: forward("warn"), error: forward("error"), fatal: forward("error") };
}

import type { Analyzer, ModelPrices } from "@mailpilot/ai";
import type { JobName } from "@mailpilot/contracts";
import type { Database, schema } from "@mailpilot/database";
import type { MailConnector } from "@mailpilot/mail-connectors";

export type AccountRow = typeof schema.mailAccounts.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;
export type TaskRow = typeof schema.tasks.$inferSelect;
export type UserRow = typeof schema.users.$inferSelect;

export interface EnqueueOptions {
  jobKey?: string;
  /** Jobs in the same named queue run one after another (used per user for analysis and budget). */
  queueName?: string;
  maxAttempts?: number;
  runAt?: Date;
}

export type Enqueue = (name: JobName, payload: object, options?: EnqueueOptions) => Promise<void>;

/** Opens a connector for an account (credentials are decrypted inside, never logged). */
export type ConnectorFactory = (account: AccountRow) => Promise<MailConnector>;

export interface PushMessage {
  kind: "digest" | "urgent" | "clarifications";
  title: string;
  body: string;
  /** mailpilot:// link the app opens, e.g. mailpilot://today */
  deepLink: string;
}

export interface Notifier {
  send(userId: string, message: PushMessage): Promise<{ status: "sent" | "skipped" | "failed"; detail: string | null }>;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerDeps {
  db: Database;
  enqueue: Enqueue;
  connectorFor: ConnectorFactory;
  /** null: analysis switched off; messages stay visibly unanalyzed. */
  analyzer: Analyzer | null;
  analyzerDisabledReason: string | null;
  /** Prices for the budget pre-check; null only when the analyzer is off. */
  prices: ModelPrices | null;
  expectedOutputTokens: number;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
  limits: { maxMessagesPerFetch: number; maxMessageBytes: number; maxFetchRounds: number; maxAnalysisAttempts: number };
}

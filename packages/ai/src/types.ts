import type { AnalysisOutput, TaskStatus } from "@mailpilot/contracts";
import type { TokenUsage } from "./pricing.js";

export interface AnalysisAddress {
  name: string | null;
  address: string;
}

/** The message to analyze, already converted to plain text and reduced (signatures, repeated quotes). */
export interface AnalysisMessage {
  id: string;
  from: AnalysisAddress | null;
  to: AnalysisAddress[];
  cc: AnalysisAddress[];
  subject: string | null;
  sentAt: string | null;
  isFromMe: boolean;
  /** The mail's own text: signature and repeated quotes removed. */
  text: string;
  /** Beginning of the most recent quoted message, context only. */
  quotedContext: string | null;
  truncated: boolean;
  attachments: Array<{ filename: string | null; contentType: string | null; size: number | null }>;
}

/** Earlier messages of the thread: summaries of earlier analyses instead of full texts (cost control). */
export interface ThreadContextEntry {
  id: string;
  sentAt: string | null;
  from: string | null;
  isFromMe: boolean;
  summary: string;
}

export interface CandidateTask {
  id: string;
  title: string;
  status: TaskStatus;
  waiting: boolean;
  deadline: string | null;
  summary: string | null;
  sameThread: boolean;
}

/** Permanent assignments the user confirmed explicitly (visible and editable as rules). */
export interface KnownFact {
  kind: "membership" | "responsibility" | "sender_relevance" | "ignore_sender";
  subject: string;
  applies: boolean;
}

export interface AskedQuestion {
  kind: string;
  subject: string | null;
  question: string;
  status: "open" | "answered" | "dismissed";
  answer: string | null;
}

export interface AnalysisInput {
  today: string;
  timeZone: string;
  ownAddresses: string[];
  displayName: string | null;
  message: AnalysisMessage;
  thread: ThreadContextEntry[];
  candidateTasks: CandidateTask[];
  facts: KnownFact[];
  askedQuestions: AskedQuestion[];
}

export interface AnalysisResult {
  output: AnalysisOutput;
  model: string;
  promptVersion: string;
  usage: TokenUsage;
  costMicros: number;
  /** A fallback model served the response after the configured model declined. */
  fallbackUsed: boolean;
  /** Corrections applied by the guardrails, kept for traceability. */
  adjustments: string[];
}

export type AnalyzerErrorCode =
  | "not_configured"
  | "refusal"
  | "max_tokens"
  | "invalid_output"
  | "rate_limited"
  | "overloaded"
  | "unavailable"
  | "auth"
  | "bad_request";

export class AnalyzerError extends Error {
  constructor(
    readonly code: AnalyzerErrorCode,
    message: string,
    readonly retryable: boolean,
    /** Tokens already billed for a failed attempt still count against the budget. */
    readonly usage: TokenUsage | null = null,
    readonly costMicros = 0,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AnalyzerError";
  }
}

/** Exchangeable LLM adapter. */
export interface Analyzer {
  readonly name: string;
  readonly model: string;
  analyze(input: AnalysisInput): Promise<AnalysisResult>;
}

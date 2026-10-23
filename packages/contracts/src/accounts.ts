import { z } from "zod";
import { AccountStatus, FolderRole, MarkerStrategy, Provider, RunStatus } from "./enums.js";
import { Id, Timestamp } from "./primitives.js";

/** What the connected server actually offers. Detected, never assumed. */
export const AccountCapabilities = z
  .object({
    incrementalSync: z.enum(["gmail_history", "graph_delta", "imap_condstore", "imap_uid", "none"]),
    customKeywords: z.boolean().describe("IMAP PERMANENTFLAGS contains \\*"),
    flagged: z.boolean(),
    labels: z.boolean(),
    categories: z.boolean(),
    copyToFolder: z.boolean(),
    webLinks: z.boolean(),
    immutableIds: z.boolean(),
    supportedMarkers: z.array(MarkerStrategy),
    notes: z.array(z.string()).describe("Human-readable limitations, German"),
  })
  .meta({ id: "AccountCapabilities" });
export type AccountCapabilities = z.infer<typeof AccountCapabilities>;

export const MarkerConfig = z
  .object({
    strategy: MarkerStrategy,
    keyword: z.string().nullable().describe("IMAP keyword or Gmail label / Outlook category name"),
    folder: z.string().nullable(),
    acknowledgedLimitations: z.boolean().describe("User confirmed the explained limitations"),
  })
  .meta({ id: "MarkerConfig" });
export type MarkerConfig = z.infer<typeof MarkerConfig>;

export const Account = z
  .object({
    id: Id,
    version: z.number().int(),
    provider: Provider,
    displayName: z.string(),
    emailAddress: z.string(),
    aliases: z.array(z.string()).describe("Weitere eigene Adressen"),
    status: AccountStatus,
    capabilities: AccountCapabilities.nullable(),
    marker: MarkerConfig,
    markerReliable: z.boolean().describe("false when the marker is not reliably visible in Apple Mail"),
    initialImportDays: z.number().int(),
    includeSent: z.boolean(),
    lastSuccessfulFetchAt: Timestamp.nullable(),
    lastSuccessfulAnalysisAt: Timestamp.nullable(),
    pendingAnalysisCount: z.number().int(),
    markerFailures: z.number().int(),
    lastError: z
      .object({ code: z.string(), message: z.string(), at: Timestamp, action: z.string().nullable() })
      .nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Account" });
export type Account = z.infer<typeof Account>;

export const Folder = z
  .object({
    id: Id,
    accountId: Id,
    name: z.string(),
    path: z.string(),
    role: FolderRole,
    selected: z.boolean(),
  })
  .meta({ id: "Folder" });
export type Folder = z.infer<typeof Folder>;

export const ImapAccountCreate = z
  .object({
    displayName: z.string().min(1).max(100),
    emailAddress: z.email(),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(993),
    secure: z.boolean().default(true).describe("Implicit TLS; STARTTLS is required otherwise"),
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(1000).describe("App-specific password where the provider requires it"),
    initialImportDays: z.number().int().min(1).max(365).default(14),
  })
  .meta({ id: "ImapAccountCreate" });
export type ImapAccountCreate = z.infer<typeof ImapAccountCreate>;

export const AccountPatch = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    status: z.enum(["active", "paused"]).optional(),
    aliases: z.array(z.email()).max(50).optional(),
    initialImportDays: z.number().int().min(1).max(365).optional(),
    includeSent: z.boolean().optional(),
    marker: MarkerConfig.optional(),
  })
  .meta({ id: "AccountPatch" });
export type AccountPatch = z.infer<typeof AccountPatch>;

export const FolderSelection = z
  .object({ selectedFolderIds: z.array(Id).max(200) })
  .meta({ id: "FolderSelection" });

export const OAuthStart = z
  .object({ authorizationUrl: z.url(), state: z.string() })
  .meta({ id: "OAuthStart" });

export const AccountCheck = z
  .object({ ok: z.boolean(), capabilities: AccountCapabilities.nullable(), problem: z.string().nullable(), action: z.string().nullable() })
  .meta({ id: "AccountCheck" });

export const ScanRun = z
  .object({
    id: Id,
    accountId: Id.nullable(),
    kind: z.enum(["scan", "analysis"]),
    trigger: z.enum(["schedule", "manual", "retry", "onboarding"]),
    status: RunStatus,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
    stats: z.object({
      fetched: z.number().int(),
      newMessages: z.number().int(),
      updatedMessages: z.number().int(),
      analyzed: z.number().int(),
      tasksCreated: z.number().int(),
      tasksUpdated: z.number().int(),
      clarifications: z.number().int(),
      skipped: z.number().int(),
      budgetPaused: z.number().int(),
      errors: z.number().int(),
    }),
    error: z.string().nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "ScanRun" });
export type ScanRun = z.infer<typeof ScanRun>;

export const ScanRequest = z.object({ accountId: Id.optional() }).meta({ id: "ScanRequest" });

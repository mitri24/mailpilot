import { z } from "zod";
import { AnalysisStatus, MarkerStatus } from "./enums.js";
import { Id, Timestamp } from "./primitives.js";

export const Address = z.object({ name: z.string().nullable(), address: z.string() }).meta({ id: "Address" });

export const AttachmentMeta = z
  .object({
    filename: z.string().nullable(),
    contentType: z.string().nullable(),
    size: z.number().int().nullable(),
    inline: z.boolean(),
  })
  .meta({ id: "AttachmentMeta" });

export const MessageSummary = z
  .object({
    id: Id,
    accountId: Id,
    subject: z.string().nullable(),
    from: Address.nullable(),
    sentAt: Timestamp.nullable(),
    snippet: z.string().nullable(),
    language: z.string().nullable(),
    hasAttachments: z.boolean(),
    analysisStatus: AnalysisStatus,
    taskIds: z.array(Id),
    folders: z.array(z.string()),
    deleted: z.boolean(),
  })
  .meta({ id: "MessageSummary" });
export type MessageSummary = z.infer<typeof MessageSummary>;

/**
 * Ways to reach the original mail. safeView is always available; the others only when the
 * provider offers them. appleMail is never claimed as universally working.
 */
export const OpenOriginal = z
  .object({
    webLink: z.url().nullable(),
    appleMailUrl: z.string().nullable().describe("message:// URL; only offered where verified, see note"),
    appleMailNote: z.string(),
    searchHints: z.object({ from: z.string().nullable(), subject: z.string().nullable(), date: z.string().nullable(), messageIdHeader: z.string().nullable() }),
  })
  .meta({ id: "OpenOriginal" });

export const MessageDetail = z
  .object({
    message: MessageSummary,
    to: z.array(Address),
    cc: z.array(Address),
    bodyText: z.string().describe("Plain text, remote content removed"),
    bodyHtml: z.string().nullable().describe("Sanitized HTML without scripts or remote images"),
    remoteContentBlocked: z.number().int(),
    attachments: z.array(AttachmentMeta),
    open: OpenOriginal,
    markerStatus: MarkerStatus,
  })
  .meta({ id: "MessageDetail" });
export type MessageDetail = z.infer<typeof MessageDetail>;

export const MessageListQuery = z.object({
  search: z.string().max(200).optional(),
  accountId: Id.optional(),
  withoutTask: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: Timestamp.optional(),
});

export const MessageList = z.object({ messages: z.array(MessageSummary) }).meta({ id: "MessageList" });

export const MessageToTask = z
  .object({
    title: z.string().min(1).max(300).optional(),
    linkToTaskId: Id.optional().describe("Attach the mail to an existing task instead"),
  })
  .meta({ id: "MessageToTask" });

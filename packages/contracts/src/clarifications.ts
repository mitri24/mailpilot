import { z } from "zod";
import { AnswerScope, ClarificationKind, ClarificationStatus } from "./enums.js";
import { Id, Timestamp } from "./primitives.js";

export const ClarificationOption = z
  .object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(80),
    scope: AnswerScope.describe("Whether choosing this option may become a permanent rule"),
  })
  .meta({ id: "ClarificationOption" });

export const Clarification = z
  .object({
    id: Id,
    version: z.number().int(),
    kind: ClarificationKind,
    status: ClarificationStatus,
    question: z.string(),
    reason: z.string().describe("Warum die Information benötigt wird"),
    excerpt: z.string().nullable(),
    options: z.array(ClarificationOption),
    allowFreeText: z.boolean(),
    taskId: Id.nullable(),
    messageId: Id.nullable(),
    answer: z
      .object({ optionId: z.string().nullable(), text: z.string().nullable(), scope: AnswerScope, answeredAt: Timestamp })
      .nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Clarification" });
export type Clarification = z.infer<typeof Clarification>;

export const ClarificationAnswer = z
  .object({
    optionId: z.string().max(40).nullable().optional(),
    text: z.string().max(2000).nullable().optional(),
    scope: AnswerScope.default("once"),
  })
  .refine((a) => Boolean(a.optionId) || Boolean(a.text), { message: "optionId or text required" })
  .meta({ id: "ClarificationAnswer" });
export type ClarificationAnswer = z.infer<typeof ClarificationAnswer>;

export const Rule = z
  .object({
    id: Id,
    version: z.number().int(),
    kind: z.enum(["membership", "sender_relevance", "ignore_sender", "responsibility"]),
    subject: z.string().describe("e.g. a group name or a sender address"),
    value: z.object({ applies: z.boolean(), note: z.string().nullable() }),
    description: z.string(),
    sourceClarificationId: Id.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Rule" });
export type Rule = z.infer<typeof Rule>;

export const RulePatch = z
  .object({ applies: z.boolean().optional(), note: z.string().max(500).nullable().optional() })
  .meta({ id: "RulePatch" });

import { z } from "zod";
import { Id, Timestamp } from "./primitives.js";

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

export const Settings = z
  .object({
    version: z.number().int(),
    timezone: z.string().describe("IANA zone, e.g. Europe/Paris"),
    scanEnabled: z.boolean(),
    scanTime: ClockTime.describe("Daily scan, local time"),
    extraScanIntervalMinutes: z.number().int().nullable().describe("Optional additional scans"),
    aiMonthlyBudgetCents: z.number().int().min(0),
    maxMessageChars: z.number().int(),
    maxAttachmentBytes: z.number().int(),
    notifyDailyDigest: z.boolean(),
    notifyUrgentDeadlines: z.boolean(),
    notifyClarifications: z.boolean(),
    quietHoursStart: ClockTime.nullable(),
    quietHoursEnd: ClockTime.nullable(),
  })
  .meta({ id: "Settings" });
export type Settings = z.infer<typeof Settings>;

export const SettingsPatch = Settings.omit({ version: true }).partial().meta({ id: "SettingsPatch" });

export const Usage = z
  .object({
    month: z.string().describe("YYYY-MM"),
    spentCents: z.number(),
    budgetCents: z.number().int(),
    budgetReached: z.boolean(),
    pendingAnalysisCount: z.number().int(),
    analyzedThisMonth: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  })
  .meta({ id: "Usage" });
export type Usage = z.infer<typeof Usage>;

export const Me = z
  .object({
    id: Id,
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    devLogin: z.boolean(),
    createdAt: Timestamp,
  })
  .meta({ id: "Me" });

export const AppleSignIn = z
  .object({
    identityToken: z.string().min(20),
    nonce: z.string().min(8).max(200).describe("Raw nonce; the token carries its SHA-256"),
    deviceName: z.string().max(100).optional(),
    platform: z.enum(["ios", "macos"]).optional(),
    fullName: z.string().max(200).nullable().optional(),
  })
  .meta({ id: "AppleSignIn" });

export const DevSignIn = z
  .object({ email: z.email(), deviceName: z.string().max(100).optional(), platform: z.enum(["ios", "macos"]).optional() })
  .meta({ id: "DevSignIn" });

export const SessionResponse = z
  .object({ token: z.string(), expiresAt: Timestamp, user: Me })
  .meta({ id: "SessionResponse" });

export const PushRegistration = z
  .object({ token: z.string().min(10).max(500), environment: z.enum(["sandbox", "production"]), platform: z.enum(["ios", "macos"]) })
  .meta({ id: "PushRegistration" });

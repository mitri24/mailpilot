import { z } from "zod";

/** Job names and payloads shared by the API (producer) and the worker (consumer). */
export const Jobs = {
  scanUser: "scan_user",
  scanAccount: "scan_account",
  analyzeMessage: "analyze_message",
  applyMarker: "apply_marker",
  applyClarification: "apply_clarification",
  scheduledScans: "scheduled_scans",
} as const;
export type JobName = (typeof Jobs)[keyof typeof Jobs];

export const ScanUserPayload = z.object({ userId: z.uuid(), trigger: z.enum(["schedule", "manual", "retry", "onboarding"]), runId: z.uuid().optional() });
export const ScanAccountPayload = z.object({
  accountId: z.uuid(),
  trigger: z.enum(["schedule", "manual", "retry", "onboarding"]),
  runId: z.uuid(),
});
export const AnalyzeMessagePayload = z.object({ messageId: z.uuid(), runId: z.uuid().nullable(), force: z.boolean().default(false) });
export const ApplyMarkerPayload = z.object({ markerOperationId: z.uuid() });
export const ApplyClarificationPayload = z.object({ clarificationId: z.uuid() });

export type ScanUserPayload = z.infer<typeof ScanUserPayload>;
export type ScanAccountPayload = z.infer<typeof ScanAccountPayload>;
export type AnalyzeMessagePayload = z.infer<typeof AnalyzeMessagePayload>;
export type ApplyMarkerPayload = z.infer<typeof ApplyMarkerPayload>;
export type ApplyClarificationPayload = z.infer<typeof ApplyClarificationPayload>;

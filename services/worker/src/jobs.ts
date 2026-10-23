import type { TaskList } from "graphile-worker";
import {
  AnalyzeMessagePayload,
  ApplyClarificationPayload,
  ApplyMarkerPayload,
  Jobs,
  ScanAccountPayload,
  ScanUserPayload,
} from "@mailpilot/contracts";
import { analyzeMessage } from "./analyze.js";
import { applyClarification } from "./clarify.js";
import type { WorkerDeps } from "./deps.js";
import { applyMarker } from "./markers.js";
import { scanAccount } from "./scan.js";
import { scheduledTick, startScans } from "./schedule.js";

/** Every job validates its payload; a malformed payload fails loudly instead of doing partial work. */
export function taskList(deps: WorkerDeps): TaskList {
  return {
    [Jobs.scanUser]: async (payload) => {
      const p = ScanUserPayload.parse(payload);
      await startScans(deps, p.userId, p.trigger);
    },
    [Jobs.scanAccount]: async (payload) => scanAccount(deps, ScanAccountPayload.parse(payload)),
    [Jobs.analyzeMessage]: async (payload) => analyzeMessage(deps, AnalyzeMessagePayload.parse(payload)),
    [Jobs.applyMarker]: async (payload) => applyMarker(deps, ApplyMarkerPayload.parse(payload)),
    [Jobs.applyClarification]: async (payload) => applyClarification(deps, ApplyClarificationPayload.parse(payload)),
    [Jobs.scheduledScans]: async () => scheduledTick(deps),
  };
}

/** Graphile crontab: the scheduler checks every five minutes; each user's own scan time decides. */
export const CRONTAB = `*/5 * * * * ${Jobs.scheduledScans} ?max=1`;

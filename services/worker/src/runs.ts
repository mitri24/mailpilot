import { eq, sql } from "drizzle-orm";
import { schema, type Executor, type RunStats } from "@mailpilot/database";

const { processingRuns } = schema;

/** Atomic counter increments inside the run's stats document. */
export async function bumpRunStats(db: Executor, runId: string | null, delta: Partial<RunStats>): Promise<void> {
  if (!runId) return;
  let expr = sql`${processingRuns.stats}`;
  for (const [key, value] of Object.entries(delta)) {
    if (!value) continue;
    expr = sql`jsonb_set(${expr}, ${`{${key}}`}::text[], to_jsonb(coalesce((${processingRuns.stats}->>${key})::int, 0) + ${value}))`;
  }
  await db.update(processingRuns).set({ stats: expr }).where(eq(processingRuns.id, runId));
}

export async function startRun(db: Executor, runId: string): Promise<void> {
  await db.update(processingRuns).set({ status: "running", startedAt: new Date() }).where(eq(processingRuns.id, runId));
}

export async function finishRun(db: Executor, runId: string, status: "succeeded" | "partial" | "failed", error: string | null = null): Promise<void> {
  await db.update(processingRuns).set({ status, error, finishedAt: new Date() }).where(eq(processingRuns.id, runId));
}

import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import type { JobName } from "@mailpilot/contracts";

export interface JobOptions {
  jobKey?: string;
  /** Jobs with the same queue name run one after another. */
  queueName?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export interface JobQueue {
  add(name: JobName, payload: unknown, options?: JobOptions): Promise<void>;
  close(): Promise<void>;
}

export async function createJobQueue(connectionString: string): Promise<JobQueue> {
  let utils: WorkerUtils | null = null;
  const get = async () => {
    utils ??= await makeWorkerUtils({ connectionString });
    return utils;
  };
  return {
    async add(name, payload, options = {}) {
      const u = await get();
      await u.addJob(name, payload as object, {
        ...(options.jobKey ? { jobKey: options.jobKey, jobKeyMode: "replace" as const } : {}),
        ...(options.queueName ? { queueName: options.queueName } : {}),
        ...(options.runAt ? { runAt: options.runAt } : {}),
        ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
      });
    },
    async close() {
      if (utils) await utils.release();
    },
  };
}

/** In-memory queue for tests: records jobs instead of running them. */
export class RecordingQueue implements JobQueue {
  readonly jobs: Array<{ name: JobName; payload: unknown; options: JobOptions }> = [];
  async add(name: JobName, payload: unknown, options: JobOptions = {}) {
    this.jobs.push({ name, payload, options });
  }
  async close() {}
}

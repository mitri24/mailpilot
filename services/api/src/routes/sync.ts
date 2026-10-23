import { ChangesQuery, ChangesResponse, MutationBatch, MutationBatchResult } from "@mailpilot/contracts";
import type { Database } from "@mailpilot/database";
import type { JobQueue } from "../queue.js";
import { getChanges } from "../domain/changes.js";
import { applyMutation } from "../domain/mutations.js";
import { authOf, type Router } from "./types.js";

export function registerSyncRoutes(r: Router, deps: { db: Database; queue: JobQueue }) {
  const { db, queue } = deps;

  r.get(
    "/v1/sync/changes",
    {
      schema: {
        tags: ["sync"],
        summary: "Änderungen seit einem Cursor (Deltas mit Tombstones); ohne Cursor ein vollständiger Stand",
        querystring: ChangesQuery,
        response: { 200: ChangesResponse },
      },
    },
    async (request) => getChanges(db, authOf(request).userId, request.query.cursor, request.query.limit),
  );

  r.post(
    "/v1/sync/mutations",
    {
      schema: {
        tags: ["sync"],
        summary: "Offline-Änderungen in Reihenfolge anwenden; jede Änderung genau einmal (Idempotency Key)",
        body: MutationBatch,
        response: { 200: MutationBatchResult },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const results = [];
      // Sequential on purpose: a client's outbox order is meaningful (create before update).
      for (const mutation of request.body.mutations) {
        results.push(await applyMutation(db, queue, userId, mutation));
      }
      return { results };
    },
  );
}

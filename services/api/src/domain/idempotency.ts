import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, userTransaction, type Database, type Tx } from "@mailpilot/database";
import { ApiError } from "../errors.js";

const { mutationReceipts } = schema;

export const hashRequest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface IdempotentOutcome<T> {
  response: T;
  afterCommit?: Array<() => Promise<void>>;
}

/**
 * Runs `fn` at most once per (user, key). A retry with the same key and request returns the
 * stored response; the same key with a different request is rejected.
 */
export async function withIdempotency<T>(
  db: Database,
  userId: string,
  key: string | undefined,
  request: unknown,
  fn: (tx: Tx) => Promise<IdempotentOutcome<T>>,
): Promise<T> {
  const idempotencyKey = key ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) {
    throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key muss eine UUID sein");
  }
  const hash = hashRequest(request);
  // The per-user write lock also serializes concurrent retries of the same key.
  const outcome = await userTransaction(db, userId, async (tx): Promise<IdempotentOutcome<T>> => {
    const existing = await tx
      .select()
      .from(mutationReceipts)
      .where(and(eq(mutationReceipts.userId, userId), eq(mutationReceipts.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing[0]) {
      if (existing[0].requestHash !== hash) {
        throw new ApiError(422, "idempotency_key_reused", "Idempotency-Key wurde für eine andere Änderung verwendet");
      }
      return { response: existing[0].response as T };
    }
    const result = await fn(tx);
    await tx.insert(mutationReceipts).values({ userId, idempotencyKey, requestHash: hash, response: result.response as object });
    return result;
  });
  for (const hook of outcome.afterCommit ?? []) await hook();
  return outcome.response;
}

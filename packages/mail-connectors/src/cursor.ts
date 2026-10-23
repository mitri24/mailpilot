import type { z } from "zod";

/** Cursors are opaque to callers; internally they are versioned JSON validated with zod. */
export function encodeCursor(value: unknown): string {
  return JSON.stringify(value);
}

export type DecodedCursor<T> = { status: "missing" } | { status: "invalid" } | { status: "ok"; value: T };

export function decodeCursor<T>(raw: string | undefined, schema: z.ZodType<T>): DecodedCursor<T> {
  if (raw === undefined || raw === "") return { status: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid" };
  }
  const result = schema.safeParse(parsed);
  return result.success ? { status: "ok", value: result.data } : { status: "invalid" };
}

import { z } from "zod";

export const Id = z.uuid();
/** Calendar date without time or zone, e.g. 2026-10-30. */
export const DateOnly = z.iso.date();
/** Point in time with offset, e.g. 2026-10-30T09:00:00+01:00. */
export const Timestamp = z.iso.datetime({ offset: true });

export const ErrorBody = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: "Error" });
export type ErrorBody = z.infer<typeof ErrorBody>;

export const Cursor = z.string().regex(/^\d+$/, "cursor is a decimal sequence number");

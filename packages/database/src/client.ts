import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can run queries: the database itself or an open transaction. */
export type Executor = Database | Tx;

export interface DbHandle {
  db: Database;
  sql: Sql;
  close: () => Promise<void>;
}

export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(url, {
    max: options.max ?? 10,
    // bigint columns (sequence numbers, IMAP UIDs) must not lose precision.
    types: { bigint: postgres.BigInt },
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });
  return { db, sql: client, close: () => client.end({ timeout: 5 }) };
}

export { schema };

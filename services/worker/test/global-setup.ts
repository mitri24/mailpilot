import { createDb, runMigrations } from "@mailpilot/database";

export const testDatabaseUrl = () => process.env.TEST_DATABASE_URL ?? "postgres://mailpilot:mailpilot@127.0.0.1:55432/mailpilot_test";

/** Creates the test database if needed and applies all migrations (Postgres from infra/docker-compose.yml). */
export async function setup() {
  const url = new URL(testDatabaseUrl());
  const name = url.pathname.slice(1);
  url.pathname = "/postgres";
  const admin = createDb(url.toString(), { max: 1 });
  try {
    const rows = await admin.sql`select 1 from pg_database where datname = ${name}`;
    if (rows.length === 0) await admin.sql.unsafe(`create database "${name}"`);
  } finally {
    await admin.close();
  }
  await runMigrations(testDatabaseUrl());
}

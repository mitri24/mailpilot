import { createDb, runMigrations } from "@mailpilot/database";
import { adminUrl, testDatabaseName, testDatabaseUrl } from "./env.js";

/** Creates the test database if needed and applies all migrations. Requires the Postgres from infra/docker-compose.yml. */
export async function setup() {
  const admin = createDb(adminUrl(), { max: 1 });
  try {
    const rows = await admin.sql`select 1 from pg_database where datname = ${testDatabaseName()}`;
    if (rows.length === 0) await admin.sql.unsafe(`create database "${testDatabaseName()}"`);
  } catch (error) {
    throw new Error(
      `Postgres not reachable for tests (${adminUrl().replace(/:[^:@/]+@/, ":***@")}). Start it with: docker compose -f infra/docker-compose.yml up -d postgres`,
      { cause: error },
    );
  } finally {
    await admin.close();
  }
  await runMigrations(testDatabaseUrl());
}

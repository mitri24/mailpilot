/** Test database: TEST_DATABASE_URL, or a `mailpilot_test` database next to the local development database. */
export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? "postgres://mailpilot:mailpilot@127.0.0.1:55432/mailpilot_test";
}

export function testDatabaseName(): string {
  return new URL(testDatabaseUrl()).pathname.slice(1);
}

export function adminUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

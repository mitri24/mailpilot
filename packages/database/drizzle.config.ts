import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://mailpilot:mailpilot@localhost:55432/mailpilot" },
  strict: true,
  verbose: false,
});

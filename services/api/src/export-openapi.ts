import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createDb } from "@mailpilot/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { RecordingQueue } from "./queue.js";

// Builds the app without touching a database (postgres.js connects lazily) and writes the OpenAPI document.
const out = resolve(process.argv[2] ?? "../../docs/openapi.json");
const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
});
const database = createDb(config.DATABASE_URL, { max: 1 });
const app = await buildApp({ config, db: database.db, queue: new RecordingQueue() });
await app.ready();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await database.close();
console.log(`OpenAPI written to ${out}`);

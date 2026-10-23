import { createDb, CredentialCipher } from "@mailpilot/database";
import { createAccountServices } from "./account-services.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createJobQueue } from "./queue.js";

const config = loadConfig();
const database = createDb(config.DATABASE_URL, { max: 10 });
const queue = await createJobQueue(config.DATABASE_URL);
const cipher = new CredentialCipher(config.CREDENTIALS_ENCRYPTION_KEY);
const app = await buildApp({ config, db: database.db, queue, accounts: createAccountServices({ config, db: database.db, cipher }) });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
  await queue.close();
  await database.close();
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.HOST, port: config.PORT });

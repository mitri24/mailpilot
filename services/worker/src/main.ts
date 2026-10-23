import { makeWorkerUtils, run } from "graphile-worker";
import { createAnalyzer, FIXTURE_PRICES, loadAiConfig } from "@mailpilot/ai";
import { createDb, CredentialCipher } from "@mailpilot/database";
import { loadWorkerConfig } from "./config.js";
import { oauthClientsFrom } from "@mailpilot/mail-connectors";
import { createConnectorFactory } from "./connectors.js";
import type { Logger, WorkerDeps } from "./deps.js";
import { CRONTAB, taskList } from "./jobs.js";
import { ApnsNotifier, NoopNotifier } from "./notify.js";

const config = loadWorkerConfig();
const ai = loadAiConfig();
const levels = ["error", "warn", "info", "debug"];
const logAt = (level: string) => (obj: object, msg?: string) => {
  if (levels.indexOf(level) > levels.indexOf(config.LOG_LEVEL)) return;
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...obj }));
};
const log: Logger = { info: logAt("info"), warn: logAt("warn"), error: logAt("error") };

const database = createDb(config.DATABASE_URL, { max: config.WORKER_CONCURRENCY + 4 });
const utils = await makeWorkerUtils({ connectionString: config.DATABASE_URL });
await utils.migrate();
const cipher = new CredentialCipher(config.CREDENTIALS_ENCRYPTION_KEY);
const apns = config.apns ? new ApnsNotifier(config.apns, database.db) : null;

const deps: WorkerDeps = {
  db: database.db,
  enqueue: async (name, payload, o = {}) => {
    await utils.addJob(name, payload, {
      ...(o.jobKey ? { jobKey: o.jobKey, jobKeyMode: "replace" as const } : {}),
      ...(o.queueName ? { queueName: o.queueName } : {}),
      ...(o.maxAttempts ? { maxAttempts: o.maxAttempts } : {}),
      ...(o.runAt ? { runAt: o.runAt } : {}),
    });
  },
  connectorFor: createConnectorFactory({ db: database.db, cipher, clients: oauthClientsFrom(config), allowSelfSignedLocalhost: config.DEV_IMAP_ALLOW_SELF_SIGNED_LOCALHOST }),
  analyzer: createAnalyzer(ai),
  analyzerDisabledReason: ai.provider === "none" ? ai.reason : null,
  prices: ai.provider === "anthropic" ? ai.prices : ai.provider === "fixture" ? FIXTURE_PRICES : null,
  expectedOutputTokens: ai.provider === "anthropic" ? ai.expectedOutputTokens : 1000,
  notifier: apns ?? new NoopNotifier(),
  log,
  now: () => new Date(),
  limits: {
    maxMessagesPerFetch: config.MAX_MESSAGES_PER_FETCH,
    maxMessageBytes: config.MAX_MESSAGE_BYTES,
    maxFetchRounds: config.MAX_FETCH_ROUNDS,
    maxAnalysisAttempts: config.MAX_ANALYSIS_ATTEMPTS,
  },
};

log.info({ ai: ai.provider, model: ai.provider === "anthropic" ? ai.model : null, push: apns ? "apns" : "off" }, "worker starting");
const runner = await run({ connectionString: config.DATABASE_URL, concurrency: config.WORKER_CONCURRENCY, taskList: taskList(deps), crontab: CRONTAB });
await runner.promise;
apns?.close();
await utils.release();
await database.close();

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Database } from "@mailpilot/database";
import { CredentialCipher } from "@mailpilot/database";
import { AppleTokenVerifier } from "./auth/apple.js";
import { resolveSession, type AuthContext } from "./auth/sessions.js";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import type { JobQueue } from "./queue.js";
import { registerAccountRoutes, type AccountServices } from "./routes/accounts.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerMiscRoutes } from "./routes/misc.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerTaskRoutes } from "./routes/tasks.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface AppDeps {
  config: Config;
  db: Database;
  queue: JobQueue;
  apple?: AppleTokenVerifier;
  accounts?: Partial<AccountServices>;
}

const PUBLIC_PREFIXES = ["/v1/auth/", "/v1/oauth/", "/health", "/openapi.json"];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] },
    bodyLimit: 1_048_576,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: false });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "MailPilot API",
        version: "1.0.0",
        description: "Aufgaben aus E-Mails. Alle Endpunkte außer /v1/auth/* und /v1/oauth/* verlangen `Authorization: Bearer <token>`.",
      },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (PUBLIC_PREFIXES.some((p) => path.startsWith(p)) || !path.startsWith("/v1/")) return;
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) throw new ApiError(401, "unauthorized", "Anmeldung erforderlich");
    const auth = await resolveSession(deps.db, token);
    if (!auth) throw new ApiError(401, "session_invalid", "Sitzung abgelaufen – bitte erneut anmelden");
    request.auth = auth;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({ error: { code: "validation_failed", message: "Ungültige Anfrage", details: error.validation } });
    }
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: { code: error.code ?? "bad_request", message: error.message } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Interner Fehler" } });
  });

  const r = app.withTypeProvider<ZodTypeProvider>();
  const cipher = new CredentialCipher(config.CREDENTIALS_ENCRYPTION_KEY);
  const apple = deps.apple ?? new AppleTokenVerifier(config.appleAudiences);

  r.get("/health", { schema: { hide: true } }, async () => ({ ok: true }));
  r.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  registerAuthRoutes(r, { config, db: deps.db, apple });
  registerTaskRoutes(r, { db: deps.db, queue: deps.queue });
  registerSyncRoutes(r, { db: deps.db, queue: deps.queue });
  registerMessageRoutes(r, { db: deps.db, queue: deps.queue });
  registerMiscRoutes(r, { db: deps.db, queue: deps.queue });
  registerAccountRoutes(r, { config, db: deps.db, queue: deps.queue, cipher, services: deps.accounts ?? {} });

  return app;
}

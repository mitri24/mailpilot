import type { FastifyBaseLogger, FastifyInstance, FastifyRequest, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError } from "../errors.js";
import type { AuthContext } from "../auth/sessions.js";

export type Router = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new ApiError(401, "unauthorized", "Anmeldung erforderlich");
  return request.auth;
}

export function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const v = request.headers["idempotency-key"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

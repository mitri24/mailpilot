export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} nicht gefunden`);
export const badRequest = (message: string, details?: unknown) => new ApiError(400, "bad_request", message, details);
export const conflict = (message: string, details?: unknown) => new ApiError(409, "conflict", message, details);
export const unauthorized = (message = "Anmeldung erforderlich") => new ApiError(401, "unauthorized", message);
export const forbidden = (message = "Keine Berechtigung") => new ApiError(403, "forbidden", message);

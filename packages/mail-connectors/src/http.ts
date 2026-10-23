import { connectorError, isConnectorError, mapHttpError, mapNetworkError, type HttpProvider } from "./errors.js";
import type { OAuthTokenSource } from "./types.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ApiRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path relative to the base URL, or an absolute URL on the same origin (nextLink/deltaLink). */
  url: string;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Statuses handed back to the caller instead of being mapped to errors (e.g. 404, 410). */
  allowStatus?: number[];
}

export interface ApiResponse<T> {
  status: number;
  body: T | null;
  headers: Headers;
}

export interface ApiClientOptions {
  provider: HttpProvider;
  baseUrl: string;
  fetch: FetchLike;
  tokens: OAuthTokenSource;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

/** Reads a JSON body; a failure while streaming the body (e.g. timeout) is a network error. */
async function readJson(response: Response, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw mapNetworkError(err, `${label} response`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksLikeTransportError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return err instanceof TypeError || name === "AbortError" || name === "TimeoutError";
}

/**
 * JSON client for Gmail and Graph. Sends the bearer token, retries exactly once after a 401
 * with a refreshed token, and maps every other failure to a ConnectorError. No automatic
 * retry on 429/5xx: the caller reschedules using `retryAfterSeconds`.
 */
export class ApiClient {
  private readonly origin: string;
  private readonly label: string;

  constructor(private readonly options: ApiClientOptions) {
    this.origin = new URL(options.baseUrl).origin;
    this.label = options.provider === "gmail" ? "Gmail API" : "Microsoft Graph";
  }

  /** Only URLs on the API origin are followed, so a tampered cursor cannot leak the token. */
  isApiUrl(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  private buildUrl(request: ApiRequest): string {
    const absolute = /^https?:\/\//i.test(request.url);
    if (absolute && !this.isApiUrl(request.url)) {
      throw connectorError("config", `${this.label}: refusing to call a foreign URL`);
    }
    const url = new URL(absolute ? request.url : `${this.options.baseUrl}${request.url}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async token(): Promise<string> {
    try {
      return await this.options.tokens.getAccessToken();
    } catch (err) {
      if (isConnectorError(err)) throw err;
      if (looksLikeTransportError(err)) throw mapNetworkError(err, `${this.label} token refresh`);
      throw connectorError("needs_reauth", `${this.label}: no access token available`, { cause: err });
    }
  }

  private async send(url: string, request: ApiRequest, token: string): Promise<Response> {
    const headers = new Headers({ Accept: "application/json", ...this.options.defaultHeaders, ...request.headers });
    headers.set("Authorization", `Bearer ${token}`);
    let body: string | undefined;
    if (request.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(request.body);
    }
    try {
      return await this.options.fetch(url, {
        method: request.method ?? "GET",
        headers,
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw mapNetworkError(err, `${this.label} request`);
    }
  }

  async request<T>(request: ApiRequest): Promise<ApiResponse<T>> {
    const url = this.buildUrl(request);
    let response = await this.send(url, request, await this.token());
    if (response.status === 401) {
      await response.body?.cancel();
      this.options.tokens.invalidate();
      response = await this.send(url, request, await this.token());
      if (response.status === 401) {
        throw mapHttpError(this.options.provider, 401, await readJson(response, this.label), null);
      }
    }
    if (request.allowStatus?.includes(response.status)) {
      return { status: response.status, body: (await readJson(response, this.label)) as T | null, headers: response.headers };
    }
    if (!response.ok) {
      throw mapHttpError(this.options.provider, response.status, await readJson(response, this.label), response.headers.get("retry-after"));
    }
    return { status: response.status, body: (await readJson(response, this.label)) as T | null, headers: response.headers };
  }

  async json<T>(request: ApiRequest): Promise<T> {
    const response = await this.request<T>(request);
    if (response.body === null) throw connectorError("server", `${this.label}: empty or invalid response`);
    return response.body;
  }
}

import type { FetchLike, OAuthTokenSource } from "../../src/index.js";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}

export type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** fetch replacement that records requests and answers through `handler`. */
export function mockFetch(handler: Handler): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : null,
    };
    requests.push(request);
    return handler(request);
  };
  return { fetch: fetchImpl, requests };
}

/** Token source double: every invalidate() switches to the next token. */
export function fakeTokens(tokens = ["token-1", "token-2", "token-3"]): { source: OAuthTokenSource; stats: { gets: number; invalidations: number } } {
  const stats = { gets: 0, invalidations: 0 };
  let index = 0;
  return {
    stats,
    source: {
      async getAccessToken() {
        stats.gets += 1;
        return tokens[Math.min(index, tokens.length - 1)] as string;
      },
      invalidate() {
        stats.invalidations += 1;
        index += 1;
      },
    },
  };
}

export function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function eml(id: string, subject: string, body = "Bitte bis Freitag prüfen."): string {
  return [
    "From: Max Muster <max@example.org>",
    "To: anna@example.com",
    `Subject: ${subject}`,
    "Date: Thu, 22 Oct 2026 10:15:00 +0200",
    `Message-ID: <${id}@example.org>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");
}

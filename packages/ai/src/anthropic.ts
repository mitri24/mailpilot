import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { KNOWN_PRICES, costMicros, type ModelPrices, type TokenUsage } from "./pricing.js";
import { buildUserContent, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt.js";
import { normalizeOutput } from "./normalize.js";
import { AnalyzerError, type AnalysisInput, type AnalysisResult, type Analyzer } from "./types.js";
import { WireOutput } from "./wire.js";

export interface AnthropicSettings {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  fallbacks: boolean;
  prices: ModelPrices;
}

/** The SDK resolves credentials itself (ANTHROPIC_API_KEY or a local `ant auth login` profile); keys stay server-side. */
export class AnthropicAnalyzer implements Analyzer {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly format = betaZodOutputFormat(WireOutput);

  constructor(
    private readonly settings: AnthropicSettings,
    client?: Anthropic,
  ) {
    // The SDK retries 408/409/429/5xx and connection errors with backoff, at most maxRetries times.
    this.client = client ?? new Anthropic({ timeout: settings.timeoutMs, maxRetries: settings.maxRetries });
  }

  get model(): string {
    return this.settings.model;
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.settings.model,
        max_tokens: this.settings.maxTokens,
        // Stable instructions first and cached; per-mail content follows in the user turn.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildUserContent(input) }],
        output_config: { format: this.format, ...(this.settings.effort ? { effort: this.settings.effort } : {}) },
        ...(this.settings.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
    } catch (error) {
      throw mapError(error);
    }

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const fallbackUsed = (response.usage.iterations ?? []).some((it) => it.type === "fallback_message");
    // A fallback model may bill at its own rates; count the higher of both so the budget never undercounts.
    const servedPrices = KNOWN_PRICES[response.model];
    const cost = Math.max(costMicros(usage, this.settings.prices), servedPrices ? costMicros(usage, servedPrices) : 0);

    if (response.stop_reason === "refusal") {
      throw new AnalyzerError("refusal", "Die KI hat die Analyse dieser Mail abgelehnt", false, usage, cost);
    }
    if (response.stop_reason === "max_tokens") {
      throw new AnalyzerError("max_tokens", "Die Antwort der KI war unvollständig (Tokenlimit)", false, usage, cost);
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new AnalyzerError("invalid_output", "Die KI-Antwort war kein gültiges JSON", true, usage, cost, { cause: error });
    }
    const parsed = WireOutput.safeParse(json);
    if (!parsed.success) {
      throw new AnalyzerError("invalid_output", `Die KI-Antwort passt nicht zum Schema: ${parsed.error.message.slice(0, 300)}`, true, usage, cost);
    }
    const { output, adjustments } = normalizeOutput(parsed.data, input);
    return { output, model: response.model, promptVersion: PROMPT_VERSION, usage, costMicros: cost, fallbackUsed, adjustments };
  }
}

/** Typed SDK errors, most specific first (APIConnectionError is a subclass of APIError). */
export function mapError(error: unknown): AnalyzerError {
  if (error instanceof AnalyzerError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AnalyzerError("auth", "Anthropic-Zugang abgelehnt – API-Schlüssel prüfen", false, null, 0, { cause: error });
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new AnalyzerError("bad_request", "Konfiguriertes Modell nicht gefunden (ANTHROPIC_MODEL)", false, null, 0, { cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AnalyzerError("rate_limited", "Anthropic-Ratenlimit erreicht", true, null, 0, { cause: error });
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.UnprocessableEntityError) {
    return new AnalyzerError("bad_request", `Anfrage abgelehnt: ${error.message.slice(0, 300)}`, false, null, 0, { cause: error });
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new AnalyzerError("overloaded", "Anthropic ist gerade nicht verfügbar", true, null, 0, { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AnalyzerError("unavailable", "Keine Verbindung zu Anthropic", true, null, 0, { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    const retryable = error.status === undefined || error.status >= 500;
    return new AnalyzerError(retryable ? "unavailable" : "bad_request", `Anthropic-Fehler ${error.status ?? ""}`.trim(), retryable, null, 0, { cause: error });
  }
  return new AnalyzerError("unavailable", error instanceof Error ? error.message : String(error), true, null, 0, { cause: error });
}

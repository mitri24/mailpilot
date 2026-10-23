/**
 * USD per million tokens. Defaults follow Anthropic's published list prices (as of 2026-10-06);
 * every value can be overridden with AI_PRICE_* so a price change never needs a code change.
 * Where no cache-read price was published with the list, 10 % of the input price is assumed.
 */
export interface ModelPrices {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /** Writing a 5-minute cache entry costs 1.25 × the input price. */
  cacheWritePerMTok: number;
}

/** Prices are kept to six decimals to avoid floating-point noise in derived values. */
export const roundPrice = (value: number) => Math.round(value * 1e6) / 1e6;

const list = (input: number, output: number, cacheRead = roundPrice(input * 0.1)): ModelPrices => ({
  inputPerMTok: input,
  outputPerMTok: output,
  cacheReadPerMTok: cacheRead,
  cacheWritePerMTok: roundPrice(input * 1.25),
});

export const KNOWN_PRICES: Readonly<Record<string, ModelPrices>> = {
  "claude-fable-5-1": list(10, 50, 0.25),
  "claude-fable-5": list(10, 50),
  "claude-opus-5-5": list(4, 20, 0.2),
  "claude-opus-5": list(5, 25),
  "claude-opus-4-8": list(5, 25),
  "claude-opus-4-7": list(5, 25),
  "claude-opus-4-6": list(5, 25),
  "claude-sonnet-5-5": list(2, 10, 0.2),
  "claude-sonnet-5": list(2, 10),
  "claude-sonnet-4-6": list(3, 15),
  "claude-haiku-5-5": list(0.1, 0.5),
  "claude-haiku-4-5": list(1, 5),
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cost in micro-USD (1 USD = 1,000,000). A price per million tokens equals micro-USD per token. */
export function costMicros(usage: TokenUsage, prices: ModelPrices): number {
  const total =
    usage.inputTokens * prices.inputPerMTok +
    usage.outputTokens * prices.outputPerMTok +
    usage.cacheReadTokens * prices.cacheReadPerMTok +
    usage.cacheWriteTokens * prices.cacheWritePerMTok;
  return Math.ceil(total);
}

/** Conservative pre-flight estimate: ~2.5 characters per token, plus the expected output size. */
export function estimateCostMicros(inputChars: number, expectedOutputTokens: number, prices: ModelPrices): number {
  const inputTokens = Math.ceil(inputChars / 2.5);
  return costMicros({ inputTokens, outputTokens: expectedOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, prices);
}

export const microsToCents = (micros: number) => micros / 10_000;

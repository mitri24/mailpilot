import { z } from "zod";
import { KNOWN_PRICES, roundPrice, type ModelPrices } from "./pricing.js";

const Num = z.coerce.number().positive();

const AiEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** anthropic: real analysis · fixture: deterministic test double (never in production) · none: analysis off. */
  AI_PROVIDER: z.enum(["anthropic", "fixture", "none"]).default("none"),
  /** Model id from configuration only; there is deliberately no built-in default. */
  ANTHROPIC_MODEL: z.string().min(1).optional(),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max", "none"]).default("medium"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().min(1024).max(64000).default(16000),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(120000),
  ANTHROPIC_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Server-side fallback when the model declines for policy reasons ("default") or off. */
  ANTHROPIC_FALLBACKS: z.enum(["default", "off"]).default("default"),
  AI_PRICE_INPUT_PER_MTOK: Num.optional(),
  AI_PRICE_OUTPUT_PER_MTOK: Num.optional(),
  AI_PRICE_CACHE_READ_PER_MTOK: Num.optional(),
  AI_PRICE_CACHE_WRITE_PER_MTOK: Num.optional(),
  /** Output tokens assumed per analysis for the budget pre-check (thinking included). */
  AI_EXPECTED_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(64000).default(3000),
});

export type AiConfig =
  | { provider: "none"; reason: string }
  | { provider: "fixture" }
  | {
      provider: "anthropic";
      model: string;
      effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
      maxTokens: number;
      timeoutMs: number;
      maxRetries: number;
      fallbacks: boolean;
      prices: ModelPrices;
      expectedOutputTokens: number;
    };

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  // An empty value in .env counts as not set.
  env = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const c = AiEnv.parse(env);
  if (c.AI_PROVIDER === "none") return { provider: "none", reason: "KI-Analyse ist nicht eingerichtet (AI_PROVIDER)" };
  if (c.AI_PROVIDER === "fixture") {
    if (c.NODE_ENV === "production") throw new Error("AI_PROVIDER=fixture is a test double and not allowed in production");
    return { provider: "fixture" };
  }
  if (!c.ANTHROPIC_MODEL) throw new Error("AI_PROVIDER=anthropic requires ANTHROPIC_MODEL");
  const known = KNOWN_PRICES[c.ANTHROPIC_MODEL];
  const input = c.AI_PRICE_INPUT_PER_MTOK ?? known?.inputPerMTok;
  const output = c.AI_PRICE_OUTPUT_PER_MTOK ?? known?.outputPerMTok;
  if (input === undefined || output === undefined) {
    // Without prices the monthly budget cannot be enforced, so analysis must not run.
    throw new Error(`No prices known for ${c.ANTHROPIC_MODEL}; set AI_PRICE_INPUT_PER_MTOK and AI_PRICE_OUTPUT_PER_MTOK`);
  }
  return {
    provider: "anthropic",
    model: c.ANTHROPIC_MODEL,
    effort: c.ANTHROPIC_EFFORT === "none" ? null : c.ANTHROPIC_EFFORT,
    maxTokens: c.ANTHROPIC_MAX_TOKENS,
    timeoutMs: c.ANTHROPIC_TIMEOUT_MS,
    maxRetries: c.ANTHROPIC_MAX_RETRIES,
    fallbacks: c.ANTHROPIC_FALLBACKS === "default",
    prices: {
      inputPerMTok: input,
      outputPerMTok: output,
      cacheReadPerMTok: c.AI_PRICE_CACHE_READ_PER_MTOK ?? known?.cacheReadPerMTok ?? roundPrice(input * 0.1),
      cacheWritePerMTok: c.AI_PRICE_CACHE_WRITE_PER_MTOK ?? known?.cacheWritePerMTok ?? roundPrice(input * 1.25),
    },
    expectedOutputTokens: c.AI_EXPECTED_OUTPUT_TOKENS,
  };
}

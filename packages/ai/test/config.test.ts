import { describe, expect, it } from "vitest";
import { costMicros, estimateCostMicros, KNOWN_PRICES, loadAiConfig, microsToCents } from "../src/index.js";

describe("AI configuration", () => {
  it("is off unless configured", () => {
    expect(loadAiConfig({}).provider).toBe("none");
  });

  it("requires a model name and known or configured prices", () => {
    expect(() => loadAiConfig({ AI_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_MODEL/);
    expect(() => loadAiConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_MODEL: "some-new-model" })).toThrow(/prices/);
    const custom = loadAiConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_MODEL: "some-new-model", AI_PRICE_INPUT_PER_MTOK: "3", AI_PRICE_OUTPUT_PER_MTOK: "15" });
    expect(custom).toMatchObject({ provider: "anthropic", model: "some-new-model", prices: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 } });
    const known = loadAiConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-opus-5-5", ANTHROPIC_EFFORT: "none" });
    expect(known).toMatchObject({ effort: null, fallbacks: true, prices: KNOWN_PRICES["claude-opus-5-5"] });
  });

  it("the fixture double is refused in production", () => {
    expect(() => loadAiConfig({ AI_PROVIDER: "fixture", NODE_ENV: "production" })).toThrow();
  });

  it("computes cost in micro-USD and cents", () => {
    const p = KNOWN_PRICES["claude-opus-5-5"]!;
    const micros = costMicros({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, p);
    expect(micros).toBe(4_000_000);
    expect(microsToCents(micros)).toBe(400);
    expect(estimateCostMicros(2500, 1000, p)).toBe(1000 * 4 + 1000 * 20);
  });
});

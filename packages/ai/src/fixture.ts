import { readFileSync } from "node:fs";
import { costMicros, type ModelPrices, type TokenUsage } from "./pricing.js";
import { buildUserContent, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt.js";
import { normalizeOutput } from "./normalize.js";
import { AnalyzerError, type AnalysisInput, type AnalysisResult, type Analyzer } from "./types.js";
import { WireOutput } from "./wire.js";

export type FixtureResolver = (input: AnalysisInput) => WireOutput | AnalyzerError | null;

export const FIXTURE_PRICES: ModelPrices = { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 };

/**
 * Deterministic test double behind the same adapter interface. It never calls a model: outputs come
 * from fixtures and run through the same guardrails. Token usage is derived from the prompt size so
 * budget handling can be exercised.
 */
export class FixtureAnalyzer implements Analyzer {
  readonly name = "fixture";
  readonly model = "fixture";
  readonly calls: AnalysisInput[] = [];

  constructor(
    private readonly resolve: FixtureResolver,
    private readonly prices: ModelPrices = FIXTURE_PRICES,
  ) {}

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    this.calls.push(input);
    const fixture = this.resolve(input);
    if (fixture instanceof AnalyzerError) throw fixture;
    if (!fixture) throw new AnalyzerError("invalid_output", `Keine Fixture für Mail „${input.message.subject ?? input.message.id}“`, false);
    const raw = WireOutput.parse(fixture);
    const usage: TokenUsage = {
      inputTokens: Math.ceil((SYSTEM_PROMPT.length + buildUserContent(input).length) / 4),
      outputTokens: Math.ceil(JSON.stringify(raw).length / 4),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const { output, adjustments } = normalizeOutput(raw, input);
    return { output, model: this.model, promptVersion: PROMPT_VERSION, usage, costMicros: costMicros(usage, this.prices), fallbackUsed: false, adjustments };
  }
}

/** Fixtures from a JSON file: { "<subject or message identity>": WireOutput }. For local demos only. */
export function fixtureFileResolver(path: string): FixtureResolver {
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return (input) => {
    const entry = data[input.message.subject ?? ""] ?? data[input.message.id];
    return entry ? WireOutput.parse(entry) : null;
  };
}

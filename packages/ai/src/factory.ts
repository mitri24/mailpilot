import { AnthropicAnalyzer } from "./anthropic.js";
import type { AiConfig } from "./config.js";
import { FixtureAnalyzer, fixtureFileResolver } from "./fixture.js";
import type { Analyzer } from "./types.js";

/** Returns null when analysis is switched off; callers then keep messages pending and say so. */
export function createAnalyzer(config: AiConfig, env: NodeJS.ProcessEnv = process.env): Analyzer | null {
  switch (config.provider) {
    case "none":
      return null;
    case "fixture": {
      const file = env.AI_FIXTURES_FILE;
      if (!file) throw new Error("AI_PROVIDER=fixture requires AI_FIXTURES_FILE");
      return new FixtureAnalyzer(fixtureFileResolver(file));
    }
    case "anthropic":
      return new AnthropicAnalyzer(config);
  }
}

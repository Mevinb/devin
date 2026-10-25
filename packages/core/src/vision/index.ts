import type { VisionConfig } from "../config/schema.js";
import { MockVisionProvider } from "./mock-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import type { VisionProvider } from "./types.js";
import type { RunBudget } from "../budget.js";

export * from "./types.js";
export * from "./cache.js";
export * from "./tile.js";
export * from "./prompt.js";
export * from "./openai-provider.js";
export * from "./mock-provider.js";

/** Custom paid providers must opt into per-attempt accounting; a single outer
 * receipt cannot safely account for their retries or image tiling. */
export function bindVisionProvider(provider: VisionProvider, budget: RunBudget): VisionProvider {
  const bound = provider.withBudget?.(budget) ?? provider;
  return {
    name: bound.name, warning: bound.warning, offline: bound.offline,
    withBudget: (next) => bindVisionProvider(provider, next),
    analyze: (image, context) => budget.run(() => {
      if (!provider.withBudget && !bound.offline) budget.rejectConfiguration(
        `Vision provider '${provider.name}' must implement withBudget() or explicitly declare offline: true`
      );
      return bound.analyze(image, context, { signal: budget.signal });
    })
  };
}

export function createVisionProvider(config: VisionConfig, budget?: RunBudget): VisionProvider {
  if (!config.enabled) {
    return new MockVisionProvider([]);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      name: "unavailable",
      offline: true,
      warning: "OpenAI vision was requested but OPENAI_API_KEY is not configured; results contain heuristic checks only.",
      analyze: async () => ({ findings: [] })
    };
  }

  return new OpenAIProvider({
    apiKey,
    model: config.model,
    maxImageDim: config.maxImageDim,
    budget,
    cacheDir: config.cacheDir
  });
}

import type { VisionConfig } from "../config/schema.js";
import { MockVisionProvider } from "./mock-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import type { VisionProvider } from "./types.js";

export * from "./types.js";
export * from "./cache.js";
export * from "./tile.js";
export * from "./prompt.js";
export * from "./openai-provider.js";
export * from "./mock-provider.js";

export function createVisionProvider(config: VisionConfig): VisionProvider {
  if (!config.enabled) {
    return new MockVisionProvider([]);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Graceful fallback to mock if no API key is provided
    return new MockVisionProvider([]);
  }

  return new OpenAIProvider({
    apiKey,
    model: config.model,
    cacheDir: config.cacheDir
  });
}

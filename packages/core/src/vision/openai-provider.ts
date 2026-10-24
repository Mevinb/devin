import OpenAI from "openai";
import { VisionCache } from "./cache.js";
import {
  VISION_SYSTEM_PROMPT,
  OPENAI_VISION_RESPONSE_SCHEMA,
  buildDOMGroundingHints
} from "./prompt.js";
import { processAndTileScreenshot, tileBBoxToFullBBox } from "./tile.js";
import type {
  RenderContext,
  VisionAnalysisResult,
  VisionFinding,
  VisionProvider,
  VisionUsage
} from "./types.js";

export class OpenAIProvider implements VisionProvider {
  name = "openai";
  private client: OpenAI;
  private model: string;
  private cache: VisionCache;

  constructor(options: { apiKey?: string; model?: string; cacheDir?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey || process.env.OPENAI_API_KEY
    });
    this.model = options.model || process.env.OPENAI_MODEL || "gpt-4o";
    this.cache = new VisionCache(options.cacheDir);
  }

  async analyze(
    imageBuffer: Buffer,
    context: RenderContext
  ): Promise<VisionAnalysisResult> {
    const cached = await this.cache.get(imageBuffer, this.model);
    if (cached) {
      return cached;
    }

    const tiles = await processAndTileScreenshot(imageBuffer);
    const aggregatedFindings: VisionFinding[] = [];
    let totalUsage: VisionUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    };

    for (const tile of tiles) {
      const base64Image = tile.buffer.toString("base64");
      const domHints = buildDOMGroundingHints(context.domSnapshot, tile);

      let attempts = 0;
      let success = false;
      let lastError: unknown;

      while (attempts < 3 && !success) {
        try {
          attempts++;
          const response = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0.1,
            response_format: {
              type: "json_schema",
              json_schema: OPENAI_VISION_RESPONSE_SCHEMA
            },
            messages: [
              {
                role: "system",
                content: VISION_SYSTEM_PROMPT
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Analyze this viewport rendering (${context.renderConfig.name}, ${context.renderConfig.width}x${context.renderConfig.height}) for visual layout and responsive defects.${domHints}`
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${base64Image}`,
                      detail: "high"
                    }
                  }
                ]
              }
            ]
          });

          if (response.usage) {
            totalUsage.promptTokens += response.usage.prompt_tokens;
            totalUsage.completionTokens += response.usage.completion_tokens;
            totalUsage.totalTokens += response.usage.total_tokens;
          }

          const rawContent = response.choices[0]?.message?.content;
          if (rawContent) {
            const parsed = JSON.parse(rawContent) as { findings: VisionFinding[] };
            if (Array.isArray(parsed.findings)) {
              for (const finding of parsed.findings) {
                // Remap tile bbox back to full screenshot coordinates
                const fullBBox = tileBBoxToFullBBox(finding.bbox, tile);
                aggregatedFindings.push({
                  ...finding,
                  bbox: fullBBox
                });
              }
            }
          }
          success = true;
        } catch (err) {
          lastError = err;
          // Exponential backoff
          await new Promise((r) => setTimeout(r, attempts * 1000));
        }
      }

      if (!success && lastError) {
        console.warn(`Vision analysis failed for tile ${tile.index}:`, lastError);
      }
    }

    const result: VisionAnalysisResult = {
      findings: aggregatedFindings,
      usage: totalUsage,
      cached: false
    };

    await this.cache.set(imageBuffer, this.model, result);
    return result;
  }
}

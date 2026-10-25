import OpenAI from "openai";
import { z } from "zod";
import { isBudgetError, RunBudget } from "../budget.js";
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

const coordinate = z.number().finite().min(0).max(1);
const ResponseSchema = z.object({ findings: z.array(z.object({
  type: z.enum(["overlapping-text", "clipped-element", "broken-layout", "obstructed-ui", "misaligned-element", "unreadable-text"]),
  severity: z.enum(["critical", "warning", "info"]), description: z.string(), confidence: coordinate,
  targetElementHint: z.string().optional(),
  bbox: z.object({ xmin: coordinate, ymin: coordinate, xmax: coordinate, ymax: coordinate })
    .refine((box) => box.xmax > box.xmin && box.ymax > box.ymin, "Empty or inverted bounding box")
})) });

function sameRegion(a: VisionFinding, b: VisionFinding): boolean {
  if (a.type !== b.type) return false;
  const intersection = Math.max(0, Math.min(a.bbox.xmax, b.bbox.xmax) - Math.max(a.bbox.xmin, b.bbox.xmin)) *
    Math.max(0, Math.min(a.bbox.ymax, b.bbox.ymax) - Math.max(a.bbox.ymin, b.bbox.ymin));
  const area = (box: VisionFinding["bbox"]) => (box.xmax - box.xmin) * (box.ymax - box.ymin);
  const union = area(a.bbox) + area(b.bbox) - intersection;
  return union > 0 && intersection / union > 0.5;
}

export class OpenAIProvider implements VisionProvider {
  name = "openai";
  private client: OpenAI;
  private model: string;
  private cache: VisionCache;
  private maxImageDim: number;
  private budget?: RunBudget;

  constructor(options: { apiKey?: string; model?: string; cacheDir?: string; maxImageDim?: number; budget?: RunBudget } = {},
    shared?: { client: OpenAI; cache: VisionCache }) {
    // Own the retry loop so request counts and eventual budget accounting are accurate.
    this.client = shared?.client ?? new OpenAI({ apiKey: options.apiKey || process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 30000 });
    this.model = options.model || process.env.OPENAI_MODEL || "gpt-4o";
    this.maxImageDim = options.maxImageDim ?? 1568;
    this.cache = shared?.cache ?? new VisionCache(options.cacheDir);
    this.budget = options.budget;
  }

  withBudget(budget: RunBudget): OpenAIProvider {
    return new OpenAIProvider({ model: this.model, maxImageDim: this.maxImageDim, budget }, { client: this.client, cache: this.cache });
  }

  async analyze(imageBuffer: Buffer, context: RenderContext): Promise<VisionAnalysisResult> {
    const budget = this.budget ??= new RunBudget();
    budget.assertActive();
    const contextKey = JSON.stringify({ prompt: VISION_SYSTEM_PROMPT, maxImageDim: this.maxImageDim, context });
    const cached = await this.cache.get(imageBuffer, this.model, contextKey);
    if (cached) { budget.cacheHit("vision"); return cached; }
    const tiles = await processAndTileScreenshot(imageBuffer, this.maxImageDim);
    const findings: VisionFinding[] = [];
    const usage: VisionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (const tile of tiles) {
      const domHints = buildDOMGroundingHints(context.domSnapshot, tile, context);
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await budget.request("vision", this.model, 2000, (requestOptions) => this.client.chat.completions.create({
            model: this.model, temperature: 0.1, max_tokens: 2000,
            response_format: { type: "json_schema", json_schema: OPENAI_VISION_RESPONSE_SCHEMA },
            messages: [{ role: "system", content: VISION_SYSTEM_PROMPT }, { role: "user", content: [
              { type: "text", text: `Analyze this viewport rendering (${context.renderConfig.name}, ${context.renderConfig.width}x${context.renderConfig.height}) for visual layout and responsive defects.${domHints}` },
              { type: "image_url", image_url: { url: `data:image/png;base64,${tile.buffer.toString("base64")}`, detail: "high" } }
            ] }]
          }, requestOptions));
          if (response.usage) {
            usage.promptTokens += response.usage.prompt_tokens;
            usage.completionTokens += response.usage.completion_tokens;
            usage.totalTokens += response.usage.total_tokens;
          }
          const content = response.choices[0]?.message.content;
          if (!content || response.choices[0]?.finish_reason === "length") throw new Error("Vision response was empty or truncated");
          const parsed = ResponseSchema.parse(JSON.parse(content));
          for (const item of parsed.findings) {
            const type: VisionFinding["type"] = item.type === "overlapping-text" ? "element-overlap" : item.type === "clipped-element" ? "text-clipping" : item.type;
            const finding: VisionFinding = { ...item, type, bbox: tileBBoxToFullBBox(item.bbox, tile) };
            const index = findings.findIndex((existing) => sameRegion(existing, finding));
            if (index < 0) findings.push(finding);
            else {
              const existing = findings[index];
              const rank = { critical: 3, warning: 2, info: 1 };
              findings[index] = { ...(existing.confidence >= finding.confidence ? existing : finding),
                confidence: Math.max(existing.confidence, finding.confidence),
                severity: rank[existing.severity] >= rank[finding.severity] ? existing.severity : finding.severity };
            }
          }
          break;
        } catch (error) {
          if (isBudgetError(error)) throw error;
          const status = (error as { status?: number }).status;
          if (attempt >= 3 || status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
            throw new Error(`Vision analysis failed for tile ${tile.index} after ${attempt} attempt(s): ${(error as Error).message}`, { cause: error });
          }
          await budget.run(() => new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1))));
        }
      }
    }
    // Only complete, validated analyses enter the cache. Failed tiles cannot look clean.
    const result: VisionAnalysisResult = { findings, usage, cached: false };
    await this.cache.set(imageBuffer, this.model, result, contextKey);
    return result;
  }
}

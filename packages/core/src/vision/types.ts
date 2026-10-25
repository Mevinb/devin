import type { RenderConfig } from "../config/schema.js";
import type { DOMSnapshot } from "../capture/types.js";
import type { DefectSeverity, DefectType } from "../heuristics/types.js";
import type { RunBudget } from "../budget.js";

/** Normalized coordinates 0.0 to 1.0 */
export interface NormalizedBBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface VisionFinding {
  type: DefectType;
  severity: DefectSeverity;
  bbox: NormalizedBBox;
  description: string;
  targetElementHint?: string;
  confidence: number;
}

export interface VisionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface VisionAnalysisResult {
  findings: VisionFinding[];
  usage?: VisionUsage;
  cached?: boolean;
}

export interface RenderContext {
  renderConfig: RenderConfig;
  domSnapshot: DOMSnapshot;
  imageWidth: number;
  imageHeight: number;
  /** Document CSS offset of a viewport-only screenshot. */
  originX?: number;
  originY?: number;
}

export interface VisionProvider {
  name: string;
  warning?: string;
  /** Explicitly declares that analysis never dispatches paid model requests. */
  offline?: boolean;
  /** Return a job-bound provider that meters every model attempt in this ledger.
   * Do not mutate a provider that may be shared by concurrent jobs. */
  withBudget?(budget: RunBudget): VisionProvider;
  analyze(imageBuffer: Buffer, context: RenderContext, options?: { signal?: AbortSignal }): Promise<VisionAnalysisResult>;
}

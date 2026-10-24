import type { RenderConfig } from "../config/schema.js";
import type { DOMSnapshot } from "../capture/types.js";
import type { DefectSeverity, DefectType } from "../heuristics/types.js";

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
}

export interface VisionProvider {
  name: string;
  analyze(imageBuffer: Buffer, context: RenderContext): Promise<VisionAnalysisResult>;
}

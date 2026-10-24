import type { DOMRectJSON } from "../capture/types.js";

export type DefectType =
  | "horizontal-overflow"
  | "text-clipping"
  | "element-overlap"
  | "clipped-interactive"
  | "tiny-tap-target"
  | "broken-layout"
  | "obstructed-ui"
  | "misaligned-element"
  | "unreadable-text"
  | "missing-content";

export type DefectSeverity = "critical" | "warning" | "info";

export interface FindingElementRef {
  id?: string;
  selector: string;
  tagName?: string;
  text?: string;
}

export interface Finding {
  id: string;
  type: DefectType;
  severity: DefectSeverity;
  confidence: number;
  sources: Array<"heuristic" | "vision">;
  bbox: DOMRectJSON;
  elements: FindingElementRef[];
  description: string;
  renderId: string;
  suggestedFix?: string;
}

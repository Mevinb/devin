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
  | "missing-content"
  | "safe-area-intrusion"
  | "keyboard-obstruction"
  | "hinge-overlap"
  | "tv-overscan-violation"
  | "tv-missing-focus-ring";

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
  // Phase 2 State and Device metadata
  stateId?: string;
  trace?: string[];
  targetId?: string;
  device?: string;
  fidelity?: "real" | "webview" | "approximate";
  proposedFixId?: string;
}


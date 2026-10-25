import type { CaptureRenderConfig, DOMRectJSON } from "../capture/types.js";

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
  | "tv-missing-focus-ring"
  | "runtime-error";

export type DefectSeverity = "critical" | "warning" | "info";

export interface FindingElementRef {
  id?: string;
  selector: string;
  tagName?: string;
  text?: string;
  source?: { file: string; line: number };
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
  /** Actual capture configuration for responsive CSS mapping and isolated replay. */
  renderConfig?: CaptureRenderConfig;
  suggestedFix?: string;
  // Phase 2 State and Device metadata
  stateId?: string;
  trace?: string[];
  /** Machine-readable actions (AgentAction[]) that reproduce the state; used by fix verification. */
  actions?: unknown[];
  targetId?: string;
  device?: string;
  fidelity?: "real" | "webview" | "approximate";
  proposedFixId?: string;
}


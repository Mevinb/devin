import type { CaptureResult } from "../capture/types.js";
import { detectHorizontalOverflow } from "./overflow.js";
import { detectTextClipping } from "./clipping.js";
import { detectElementOverlap } from "./overlap.js";
import { detectClippedInteractive } from "./interactive.js";
import { detectTinyTapTargets } from "./touch-targets.js";
import type { Finding } from "./types.js";

export * from "./types.js";
export * from "./overflow.js";
export * from "./clipping.js";
export * from "./overlap.js";
export * from "./interactive.js";
export * from "./touch-targets.js";

export function runHeuristics(capture: CaptureResult): Finding[] {
  const findings: Finding[] = [];

  findings.push(...detectHorizontalOverflow(capture));
  findings.push(...detectTextClipping(capture));
  findings.push(...detectElementOverlap(capture));
  findings.push(...detectClippedInteractive(capture));
  findings.push(...detectTinyTapTargets(capture));

  return findings;
}

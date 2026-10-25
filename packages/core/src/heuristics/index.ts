import type { CaptureResult } from "../capture/types.js";
import { detectHorizontalOverflow } from "./overflow.js";
import { detectTextClipping } from "./clipping.js";
import { detectElementOverlap } from "./overlap.js";
import { detectClippedInteractive } from "./interactive.js";
import { detectTinyTapTargets } from "./touch-targets.js";
import { runDeviceHeuristics } from "./device/index.js";
import { detectRuntimeErrors } from "./runtime-errors.js";
import type { Finding } from "./types.js";

export * from "./types.js";
export * from "./overflow.js";
export * from "./clipping.js";
export * from "./overlap.js";
export * from "./interactive.js";
export * from "./touch-targets.js";
export * from "./device/index.js";
export * from "./runtime-errors.js";

export function runHeuristics(capture: CaptureResult): Finding[] {
  const findings: Finding[] = [];

  findings.push(...detectHorizontalOverflow(capture));
  findings.push(...detectTextClipping(capture));
  findings.push(...detectElementOverlap(capture));
  findings.push(...detectClippedInteractive(capture));
  findings.push(...detectTinyTapTargets(capture));
  findings.push(...runDeviceHeuristics(capture));
  findings.push(...detectRuntimeErrors(capture));

  return findings;
}


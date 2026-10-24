import type { CaptureResult } from "../../capture/types.js";
import type { Finding } from "../types.js";
import { detectTvFocusRing } from "./focus-ring.js";
import { detectHingeOverlap } from "./hinge.js";
import { detectKeyboardObstruction } from "./keyboard.js";
import { detectTvOverscan } from "./overscan.js";
import { detectSafeAreaIntrusions } from "./safe-area.js";

export * from "./safe-area.js";
export * from "./keyboard.js";
export * from "./hinge.js";
export * from "./overscan.js";
export * from "./focus-ring.js";

export function runDeviceHeuristics(capture: CaptureResult): Finding[] {
  const findings: Finding[] = [];

  findings.push(...detectSafeAreaIntrusions(capture));
  findings.push(...detectKeyboardObstruction(capture));
  findings.push(...detectHingeOverlap(capture));
  findings.push(...detectTvOverscan(capture));
  findings.push(...detectTvFocusRing(capture));

  return findings;
}

import type { CaptureResult } from "../../capture/types.js";
import { BUILTIN_DEVICES } from "../../runtime/registry.js";
import type { DeviceTarget } from "../../runtime/types.js";
import type { Finding } from "../types.js";

function getDeviceTarget(capture: CaptureResult): DeviceTarget | null {
  const cfg = capture.renderConfig as unknown as Record<string, unknown>;
  if (cfg.deviceTarget) return cfg.deviceTarget as DeviceTarget;
  if (cfg.deviceDescriptor && BUILTIN_DEVICES[cfg.deviceDescriptor as string]) {
    return BUILTIN_DEVICES[cfg.deviceDescriptor as string];
  }
  for (const device of Object.values(BUILTIN_DEVICES)) {
    if (
      device.name.toLowerCase() === capture.renderConfig.name.toLowerCase() ||
      device.id.toLowerCase() === capture.renderConfig.renderId.toLowerCase()
    ) {
      return device;
    }
  }
  return null;
}

export function detectHingeOverlap(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const target = getDeviceTarget(capture);
  if (!target || !target.isFoldable || !target.hingeRect) {
    return [];
  }

  const { hingeRect } = target;
  const findings: Finding[] = [];

  for (const el of domSnapshot.elements) {
    const { rect, text, isInteractive, tagName } = el;
    if (rect.width <= 0 || rect.height <= 0) continue;

    // Ignore html, body, and full-screen outer containers
    if (
      tagName.toLowerCase() === "html" ||
      tagName.toLowerCase() === "body" ||
      (rect.width >= renderConfig.width - 10 && rect.height >= renderConfig.height - 10)
    ) {
      continue;
    }

    const hasSignificantContent = isInteractive || (text && text.trim().length > 3);
    if (!hasSignificantContent) continue;

    // Check if the element spans across the hinge
    // For vertical hinge (foldable phone like Pixel Fold in portrait/landscape):
    const spansVerticalHinge =
      rect.left < hingeRect.x &&
      rect.right > hingeRect.x + hingeRect.width &&
      rect.top < hingeRect.y + hingeRect.height &&
      rect.bottom > hingeRect.y;

    if (spansVerticalHinge) {
      findings.push({
        id: `hinge-overlap-${el.id || el.selector}-${renderConfig.renderId}`,
        type: "hinge-overlap",
        severity: "critical",
        confidence: 0.94,
        sources: ["heuristic"],
        bbox: rect,
        elements: [
          {
            id: el.id,
            selector: el.selector,
            tagName: el.tagName,
            text: el.text
          }
        ],
        description: `Element <${el.tagName}> "${el.text?.slice(0, 30) || el.selector}" spans across the device physical hinge seam (x: ${hingeRect.x}px to ${hingeRect.x + hingeRect.width}px). Content will be split or distorted by the screen fold.`,
        renderId: renderConfig.renderId,
        targetId: target.id,
        device: target.name,
        fidelity: target.fidelity,
        suggestedFix:
          "Use CSS dual-screen media query `@media (horizontal-viewport-segments: 2)` or `env(viewport-segment-width 0 0)` to place content cleanly on one side of the fold."
      });
    }
  }

  return findings;
}

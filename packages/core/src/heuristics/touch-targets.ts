import type { CaptureResult } from "../capture/types.js";
import type { Finding } from "./types.js";

export function detectTinyTapTargets(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;

  // Only check touch target sizes on mobile / touch-enabled viewports
  if (!renderConfig.isMobile && !renderConfig.hasTouch) {
    return [];
  }

  const findings: Finding[] = [];

  for (const el of domSnapshot.elements) {
    if (!el.isInteractive) continue;
    if (el.rect.width <= 0 || el.rect.height <= 0) continue;

    // Minimum target size: 24 CSS px
    if (el.rect.width < 24 || el.rect.height < 24) {
      findings.push({
        id: `tap-target-${renderConfig.renderId}-${el.id}`,
        type: "tiny-tap-target",
        severity: "warning",
        confidence: 0.85,
        sources: ["heuristic"],
        bbox: el.rect,
        elements: [
          {
            id: el.id,
            selector: el.selector,
            tagName: el.tagName,
            text: el.text
          }
        ],
        description: `Small touch target on mobile: <${el.tagName}> has dimensions ${el.rect.width}x${el.rect.height}px (recommended minimum: 24x24px, optimal: 44x44px).`,
        renderId: renderConfig.renderId,
        suggestedFix:
          "Increase `min-width` and `min-height` or add padding to ensure easy touch interaction on mobile screens."
      });
    }
  }

  return findings.slice(0, 10);
}

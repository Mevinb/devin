import type { CaptureResult } from "../capture/types.js";
import type { Finding } from "./types.js";

export function detectClippedInteractive(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const findings: Finding[] = [];
  const viewportWidth = renderConfig.width;

  for (const el of domSnapshot.elements) {
    if (!el.isInteractive) continue;
    if (el.rect.width <= 0 || el.rect.height <= 0) continue;

    // Check if element is partially cut off by viewport edge
    const partiallyOffscreenRight = el.rect.left < viewportWidth && el.rect.right > viewportWidth;
    const partiallyOffscreenLeft = el.rect.left < 0 && el.rect.right > 0;

    if (partiallyOffscreenRight || partiallyOffscreenLeft) {
      findings.push({
        id: `clipped-interactive-${renderConfig.renderId}-${el.id}`,
        type: "clipped-interactive",
        severity: "critical",
        confidence: 0.95,
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
        description: `Interactive element <${el.tagName}> ("${el.text || el.selector}") is clipped by viewport boundary.`,
        renderId: renderConfig.renderId,
        suggestedFix:
          "Wrap within responsive grid/flex container or add padding to ensure clickable buttons remain entirely within viewport."
      });
    }
  }

  return findings.slice(0, 10);
}

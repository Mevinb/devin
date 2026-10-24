import type { CaptureResult } from "../capture/types.js";
import type { Finding } from "./types.js";

export function detectTextClipping(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const findings: Finding[] = [];

  for (const el of domSnapshot.elements) {
    if (!el.text || el.text.trim().length < 3) continue;
    if (el.rect.width <= 0 || el.rect.height <= 0) continue;

    const hasHorizontalClip =
      el.metrics.scrollWidth > el.metrics.clientWidth + 4 &&
      (el.styles.overflowX === "hidden" || el.styles.overflow === "hidden" || el.styles.overflowX === "clip");

    const hasVerticalClip =
      el.metrics.scrollHeight > el.metrics.clientHeight + 4 &&
      (el.styles.overflowY === "hidden" || el.styles.overflow === "hidden" || el.styles.overflowY === "clip");

    if (hasHorizontalClip || hasVerticalClip) {
      const axis = hasHorizontalClip && hasVerticalClip ? "both" : hasHorizontalClip ? "horizontal" : "vertical";
      const diff = hasHorizontalClip
        ? el.metrics.scrollWidth - el.metrics.clientWidth
        : el.metrics.scrollHeight - el.metrics.clientHeight;

      findings.push({
        id: `text-clip-${renderConfig.renderId}-${el.id}`,
        type: "text-clipping",
        severity: "warning",
        confidence: 0.9,
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
        description: `Text clipped along ${axis} axis (${diff}px clipped): text "${el.text.slice(0, 40)}..." inside <${el.tagName}> overflows container with overflow:hidden.`,
        renderId: renderConfig.renderId,
        suggestedFix:
          "Allow container to expand (`height: auto` / `min-height`), use `text-overflow: ellipsis`, or adjust font size/padding."
      });
    }
  }

  return findings.slice(0, 10); // Bound findings per render
}

import type { CaptureResult } from "../capture/types.js";
import type { Finding } from "./types.js";

export function detectHorizontalOverflow(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const doc = domSnapshot.document;
  const viewportWidth = renderConfig.width;

  if (doc.scrollWidth <= viewportWidth + 2) {
    return [];
  }

  // Find culprit elements that spill past the viewport
  const overflowingElements = domSnapshot.elements.filter(
    (el) => el.rect.right > viewportWidth + 2 && el.rect.width > 0 && el.rect.height > 0
  );

  // Sort culprits by how far they extend to find the primary offenders
  overflowingElements.sort((a, b) => b.rect.right - a.rect.right);

  const primaryCulprits = overflowingElements.slice(0, 3);
  const maxRight = primaryCulprits[0]?.rect.right || doc.scrollWidth;

  const bbox = primaryCulprits[0]?.rect || {
    x: viewportWidth,
    y: 0,
    width: doc.scrollWidth - viewportWidth,
    height: Math.min(doc.scrollHeight, renderConfig.height),
    top: 0,
    left: viewportWidth,
    right: doc.scrollWidth,
    bottom: Math.min(doc.scrollHeight, renderConfig.height)
  };

  const culpritNames = primaryCulprits.map((c) => c.selector).join(", ");

  return [
    {
      id: `h-overflow-${renderConfig.renderId}`,
      type: "horizontal-overflow",
      severity: "critical",
      confidence: 0.98,
      sources: ["heuristic"],
      bbox,
      elements: primaryCulprits.map((c) => ({
        id: c.id,
        selector: c.selector,
        tagName: c.tagName,
        text: c.text
      })),
      description: `Horizontal viewport overflow: page width (${doc.scrollWidth}px) exceeds viewport width (${viewportWidth}px) by ${doc.scrollWidth - viewportWidth}px. Primary culprits: ${culpritNames || "document body"}.`,
      renderId: renderConfig.renderId,
      suggestedFix:
        "Apply `max-width: 100%`, `overflow-x: hidden`, or replace fixed widths with fluid percentages/clamp()."
    }
  ];
}

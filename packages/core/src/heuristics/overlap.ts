import type { CaptureResult, DOMElementSnapshot } from "../capture/types.js";
import type { Finding } from "./types.js";

function areRelated(
  elA: DOMElementSnapshot,
  elB: DOMElementSnapshot,
  elementMap: Map<string, DOMElementSnapshot>
): boolean {
  // Check if A is ancestor of B
  let current: DOMElementSnapshot | undefined = elB;
  while (current && current.parentId) {
    if (current.parentId === elA.id) return true;
    current = elementMap.get(current.parentId);
  }

  // Check if B is ancestor of A
  current = elA;
  while (current && current.parentId) {
    if (current.parentId === elB.id) return true;
    current = elementMap.get(current.parentId);
  }

  return false;
}

export function detectElementOverlap(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const findings: Finding[] = [];

  const elementMap = new Map<string, DOMElementSnapshot>();
  for (const el of domSnapshot.elements) {
    elementMap.set(el.id, el);
  }

  // Candidates: visible elements with substantive text or interactive purpose
  const candidates = domSnapshot.elements.filter((el) => {
    if (el.rect.width < 10 || el.rect.height < 10) return false;
    const hasText = el.text && el.text.trim().length > 1;
    return hasText || el.isInteractive;
  });

  // Sort by Y for spatial efficiency
  candidates.sort((a, b) => a.rect.top - b.rect.top);

  const reportedPairs = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];

      // If b's top is past a's bottom, no further overlap possible with a
      if (b.rect.top >= a.rect.bottom) {
        break;
      }

      // Check horizontal overlap
      if (a.rect.left >= b.rect.right || b.rect.left >= a.rect.right) {
        continue;
      }

      // Ignore ancestor-descendant relationships
      if (areRelated(a, b, elementMap)) {
        continue;
      }

      // Ignore intentional backdrops or modals (large z-index gap > 50)
      if (Math.abs(a.styles.zIndex - b.styles.zIndex) >= 50) {
        continue;
      }

      // Calculate intersection
      const intLeft = Math.max(a.rect.left, b.rect.left);
      const intTop = Math.max(a.rect.top, b.rect.top);
      const intRight = Math.min(a.rect.right, b.rect.right);
      const intBottom = Math.min(a.rect.bottom, b.rect.bottom);

      const intWidth = Math.max(0, intRight - intLeft);
      const intHeight = Math.max(0, intBottom - intTop);
      const intArea = intWidth * intHeight;

      const areaA = a.rect.width * a.rect.height;
      const areaB = b.rect.width * b.rect.height;
      const minArea = Math.min(areaA, areaB);

      // Overlap threshold: intersection > 100px² and at least 20% of smaller element
      if (intArea > 100 && intArea / minArea > 0.2) {
        const pairKey = [a.id, b.id].sort().join("::");
        if (reportedPairs.has(pairKey)) continue;
        reportedPairs.add(pairKey);

        const isInteractiveOverlap = a.isInteractive || b.isInteractive;
        const severity = isInteractiveOverlap ? "critical" : "warning";

        findings.push({
          id: `overlap-${renderConfig.renderId}-${a.id}-${b.id}`,
          type: "element-overlap",
          severity,
          confidence: 0.88,
          sources: ["heuristic"],
          bbox: {
            x: intLeft,
            y: intTop,
            width: intWidth,
            height: intHeight,
            left: intLeft,
            top: intTop,
            right: intRight,
            bottom: intBottom
          },
          elements: [
            { id: a.id, selector: a.selector, tagName: a.tagName, text: a.text },
            { id: b.id, selector: b.selector, tagName: b.tagName, text: b.text }
          ],
          description: `Unintended overlap between "${a.text?.slice(0, 30) || a.selector}" and "${b.text?.slice(0, 30) || b.selector}" (${Math.round(intArea)}px² overlap).`,
          renderId: renderConfig.renderId,
          suggestedFix:
            "Adjust layout flow, margin, padding, or flex/grid gap to prevent overlapping sibling elements."
        });

        if (findings.length >= 10) return findings;
      }
    }
  }

  return findings;
}

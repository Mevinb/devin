import type { DOMElementSnapshot, DOMRectJSON } from "../capture/types.js";
import type { FindingElementRef } from "../heuristics/types.js";
import type { NormalizedBBox } from "../vision/types.js";

export function normalizedBBoxToCSSPixels(
  bbox: NormalizedBBox,
  pageWidth: number,
  pageHeight: number
): DOMRectJSON {
  const left = Math.round(bbox.xmin * pageWidth);
  const top = Math.round(bbox.ymin * pageHeight);
  const right = Math.round(bbox.xmax * pageWidth);
  const bottom = Math.round(bbox.ymax * pageHeight);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  return {
    x: left,
    y: top,
    width,
    height,
    left,
    top,
    right,
    bottom
  };
}

export function calculateIoU(a: DOMRectJSON, b: DOMRectJSON): number {
  const intLeft = Math.max(a.left, b.left);
  const intTop = Math.max(a.top, b.top);
  const intRight = Math.min(a.right, b.right);
  const intBottom = Math.min(a.bottom, b.bottom);

  const intWidth = Math.max(0, intRight - intLeft);
  const intHeight = Math.max(0, intBottom - intTop);
  const intArea = intWidth * intHeight;

  if (intArea === 0) return 0;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const unionArea = areaA + areaB - intArea;

  return unionArea <= 0 ? 0 : intArea / unionArea;
}

export function calculateOverlapRatio(target: DOMRectJSON, container: DOMRectJSON): number {
  const intLeft = Math.max(target.left, container.left);
  const intTop = Math.max(target.top, container.top);
  const intRight = Math.min(target.right, container.right);
  const intBottom = Math.min(target.bottom, container.bottom);

  const intWidth = Math.max(0, intRight - intLeft);
  const intHeight = Math.max(0, intBottom - intTop);
  const intArea = intWidth * intHeight;

  const targetArea = target.width * target.height;
  return targetArea <= 0 ? 0 : intArea / targetArea;
}

export function matchBBoxToDOMElements(
  bbox: DOMRectJSON,
  elements: DOMElementSnapshot[]
): FindingElementRef[] {
  // Candidate elements that have significant intersection with bbox
  const matches: Array<{ element: DOMElementSnapshot; score: number }> = [];

  for (const el of elements) {
    if (el.rect.width === 0 || el.rect.height === 0) continue;

    const iou = calculateIoU(bbox, el.rect);
    const overlap = calculateOverlapRatio(el.rect, bbox);

    // Score based on IoU and containment
    const score = iou * 0.7 + overlap * 0.3;

    if (score > 0.15 || (overlap > 0.4 && el.isInteractive)) {
      matches.push({ element: el, score });
    }
  }

  // Sort by score descending; prioritize specific smallest element if score is close
  matches.sort((a, b) => {
    if (Math.abs(a.score - b.score) < 0.1) {
      // Prefer smaller more specific element
      const areaA = a.element.rect.width * a.element.rect.height;
      const areaB = b.element.rect.width * b.element.rect.height;
      return areaA - areaB;
    }
    return b.score - a.score;
  });

  return matches.slice(0, 3).map((m) => ({
    id: m.element.id,
    selector: m.element.selector,
    tagName: m.element.tagName,
    text: m.element.text
  }));
}

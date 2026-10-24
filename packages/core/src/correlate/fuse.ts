import type { CaptureResult } from "../capture/types.js";
import type { Finding } from "../heuristics/types.js";
import type { VisionFinding } from "../vision/types.js";
import {
  calculateIoU,
  matchBBoxToDOMElements,
  normalizedBBoxToCSSPixels
} from "./spatial.js";

export function correlateAndFuseFindings(
  capture: CaptureResult,
  heuristicFindings: Finding[],
  visionFindings: VisionFinding[]
): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const pageWidth = domSnapshot.document.scrollWidth;
  const pageHeight = domSnapshot.document.scrollHeight;

  // Convert vision findings to standard Finding objects
  const convertedVisionFindings: Finding[] = visionFindings.map((vf, index) => {
    const cssBBox = normalizedBBoxToCSSPixels(vf.bbox, pageWidth, pageHeight);
    const matchedElements = matchBBoxToDOMElements(cssBBox, domSnapshot.elements);

    return {
      id: `vision-${renderConfig.renderId}-${index}`,
      type: vf.type,
      severity: vf.severity,
      confidence: vf.confidence,
      sources: ["vision"],
      bbox: cssBBox,
      elements: matchedElements,
      description: vf.description,
      renderId: renderConfig.renderId
    };
  });

  const finalFindings: Finding[] = [];
  const mergedVisionIndices = new Set<number>();

  // Check each heuristic finding against vision findings
  for (const hFinding of heuristicFindings) {
    let matchedVisionIndex = -1;
    let highestIoU = 0;

    for (let vIdx = 0; vIdx < convertedVisionFindings.length; vIdx++) {
      if (mergedVisionIndices.has(vIdx)) continue;

      const vFinding = convertedVisionFindings[vIdx];
      const iou = calculateIoU(hFinding.bbox, vFinding.bbox);

      // Check if they share any matched DOM elements
      const sharedElement = hFinding.elements.some((hEl) =>
        vFinding.elements.some((vEl) => vEl.selector === hEl.selector)
      );

      if (iou > 0.25 || (sharedElement && iou > 0.1)) {
        if (iou > highestIoU) {
          highestIoU = iou;
          matchedVisionIndex = vIdx;
        }
      }
    }

    if (matchedVisionIndex >= 0) {
      mergedVisionIndices.add(matchedVisionIndex);
      const vFinding = convertedVisionFindings[matchedVisionIndex];

      // Boost confidence and pick highest severity
      const boostedConfidence = Math.min(
        0.99,
        Math.max(hFinding.confidence, vFinding.confidence) + 0.1
      );

      const severityRank = { critical: 3, warning: 2, info: 1 };
      const highestSeverity =
        severityRank[vFinding.severity] > severityRank[hFinding.severity]
          ? vFinding.severity
          : hFinding.severity;

      // Combine element references
      const combinedElements = [...hFinding.elements];
      for (const el of vFinding.elements) {
        if (!combinedElements.some((e) => e.selector === el.selector)) {
          combinedElements.push(el);
        }
      }

      finalFindings.push({
        id: `fused-${hFinding.id}`,
        type: hFinding.type,
        severity: highestSeverity,
        confidence: Number(boostedConfidence.toFixed(2)),
        sources: ["heuristic", "vision"],
        bbox: hFinding.bbox,
        elements: combinedElements,
        description: `${hFinding.description} (Confirmed by Vision AI: ${vFinding.description})`,
        renderId: renderConfig.renderId,
        suggestedFix: hFinding.suggestedFix
      });
    } else {
      finalFindings.push(hFinding);
    }
  }

  // Add remaining unmerged vision findings
  for (let vIdx = 0; vIdx < convertedVisionFindings.length; vIdx++) {
    if (!mergedVisionIndices.has(vIdx)) {
      finalFindings.push(convertedVisionFindings[vIdx]);
    }
  }

  return finalFindings;
}

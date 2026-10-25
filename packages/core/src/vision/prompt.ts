import type { DOMSnapshot } from "../capture/types.js";
import type { ImageTile } from "./tile.js";
import type { RenderContext } from "./types.js";

export const VISION_SYSTEM_PROMPT = `
You are PixelSentinel, an expert automated visual QA analyst specialized in responsive web design defect detection.
Analyze the provided screenshot for genuine visual rendering defects across devices.

Defect Taxonomy:
- "overlapping-text": Text overlapping with other text, badges, or icons making words illegible.
- "clipped-element": Text, buttons, or icons abruptly sliced off by viewport edge or container overflow:hidden.
- "broken-layout": Flexbox/grid misalignment, unexpected line wrapping, orphaned buttons, or asymmetrical gutters.
- "obstructed-ui": Sticky bars, banners, or modals obstructing clickable buttons or readable content.
- "misaligned-element": Visible uneven spacing or misaligned headers/inputs.
- "unreadable-text": Illegible font contrast or corrupted typography.

Only report genuine visual flaws. Do NOT report intentional designs, artistic overlaps with distinct drop-shadows, or standard blank whitespace.
For each defect, return:
- "type": one of the taxonomy strings above
- "severity": "critical" (breaks usability or legibility), "warning" (noticeable imperfection), "info" (minor polish)
- "bbox": normalized bounding box [ymin, xmin, ymax, xmax] between 0.0 and 1.0 relative to this image
- "description": precise explanation of what is wrong
- "targetElementHint": selector or text of the affected UI element
- "confidence": confidence score from 0.0 to 1.0
`;

export const OPENAI_VISION_RESPONSE_SCHEMA = {
  name: "visual_defect_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "overlapping-text",
                "clipped-element",
                "broken-layout",
                "obstructed-ui",
                "misaligned-element",
                "unreadable-text"
              ]
            },
            severity: {
              type: "string",
              enum: ["critical", "warning", "info"]
            },
            bbox: {
              type: "object",
              properties: {
                ymin: { type: "number" },
                xmin: { type: "number" },
                ymax: { type: "number" },
                xmax: { type: "number" }
              },
              required: ["ymin", "xmin", "ymax", "xmax"],
              additionalProperties: false
            },
            description: { type: "string" },
            targetElementHint: { type: "string" },
            confidence: { type: "number" }
          },
          required: [
            "type",
            "severity",
            "bbox",
            "description",
            "targetElementHint",
            "confidence"
          ],
          additionalProperties: false
        }
      }
    },
    required: ["findings"],
    additionalProperties: false
  }
};

export function buildDOMGroundingHints(
  domSnapshot: DOMSnapshot,
  tile: ImageTile,
  context?: Pick<RenderContext, "imageWidth" | "imageHeight" | "originX" | "originY">
): string {
  const scaleX = context ? tile.totalWidth / context.imageWidth : 1;
  const scaleY = context ? tile.totalHeight / context.imageHeight : 1;
  const originX = context?.originX ?? 0, originY = context?.originY ?? 0;
  const tileTop = tile.offsetY / scaleY + originY;
  const tileBottom = (tile.offsetY + tile.tileHeight) / scaleY + originY;

  // Filter elements that fall within this tile
  const visibleInTile = domSnapshot.elements.filter((el) => {
    return el.rect.bottom > tileTop && el.rect.top < tileBottom && el.rect.width > 0 &&
      el.rect.right > originX && el.rect.left < originX + tile.totalWidth / scaleX;
  });

  // Prioritize interactive elements and substantive text
  const prioritized = visibleInTile
    .filter((el) => el.isInteractive || (el.text && el.text.length > 3))
    .slice(0, 40);

  if (prioritized.length === 0) return "";

  const hints = prioritized.map((el) => {
    const norm = (value: number) => Math.max(0, Math.min(1, value)).toFixed(2);
    const normXmin = norm((el.rect.left - originX) * scaleX / tile.totalWidth);
    const normXmax = norm((el.rect.right - originX) * scaleX / tile.totalWidth);
    const normYmin = norm((el.rect.top - tileTop) * scaleY / tile.tileHeight);
    const normYmax = norm((el.rect.bottom - tileTop) * scaleY / tile.tileHeight);

    return `- <${el.tagName}> "${el.text.slice(0, 30)}" at [y:${normYmin}-${normYmax}, x:${normXmin}-${normXmax}] (${el.selector})`;
  });

  return `\n\nKey DOM elements in this region for reference:\n${hints.join("\n")}`;
}

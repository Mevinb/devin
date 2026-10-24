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

export function detectTvOverscan(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const target = getDeviceTarget(capture);
  const isTV = target?.isTV ?? renderConfig.name.toLowerCase().includes("tv");
  if (!isTV) return [];

  const findings: Finding[] = [];
  const width = renderConfig.width;
  const height = renderConfig.height;

  // Title-safe area is 90% of screen (5% margin on each edge)
  const safeMarginX = Math.round(width * 0.05);
  const safeMarginY = Math.round(height * 0.05);

  const safeMinX = safeMarginX;
  const safeMaxX = width - safeMarginX;
  const safeMinY = safeMarginY;
  const safeMaxY = height - safeMarginY;

  for (const el of domSnapshot.elements) {
    const { rect, text, isInteractive, tagName } = el;
    if (rect.width <= 0 || rect.height <= 0) continue;

    // Skip root/body and large backdrop elements
    if (
      tagName.toLowerCase() === "html" ||
      tagName.toLowerCase() === "body" ||
      (rect.width >= width && rect.height >= height)
    ) {
      continue;
    }

    const isImportantContent =
      isInteractive ||
      tagName.match(/^h[1-6]$/i) ||
      (text && text.trim().length > 0 && rect.width < width * 0.9);

    if (!isImportantContent) continue;

    const violatesLeft = rect.left < safeMinX;
    const violatesRight = rect.right > safeMaxX;
    const violatesTop = rect.top < safeMinY;
    const violatesBottom = rect.bottom > safeMaxY;

    if (violatesLeft || violatesRight || violatesTop || violatesBottom) {
      findings.push({
        id: `tv-overscan-${el.id || el.selector}-${renderConfig.renderId}`,
        type: "tv-overscan-violation",
        severity: "warning",
        confidence: 0.91,
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
        description: `TV element <${el.tagName}> "${el.text?.slice(0, 30) || el.selector}" exceeds the 5% overscan safe zone boundary [X: ${safeMinX}-${safeMaxX}px, Y: ${safeMinY}-${safeMaxY}px] at rect [${Math.round(rect.left)}, ${Math.round(rect.top)}, ${Math.round(rect.width)}x${Math.round(rect.height)}]. May be clipped by physical television bezels.`,
        renderId: renderConfig.renderId,
        targetId: target?.id,
        device: target?.name || renderConfig.name,
        fidelity: target?.fidelity,
        suggestedFix:
          "Enforce a 5% overscan margin with `padding: 5%` or `box-sizing: border-box; padding: 54px 96px;` on the root TV layout container."
      });
    }
  }

  return findings;
}

import type { CaptureResult } from "../../capture/types.js";
import { BUILTIN_DEVICES } from "../../runtime/registry.js";
import type { DeviceTarget } from "../../runtime/types.js";
import type { Finding } from "../types.js";

function getDeviceTarget(capture: CaptureResult): DeviceTarget | null {
  const cfg = capture.renderConfig as unknown as Record<string, unknown>;
  if (cfg.deviceTarget) {
    return cfg.deviceTarget as DeviceTarget;
  }
  if (cfg.deviceDescriptor && BUILTIN_DEVICES[cfg.deviceDescriptor as string]) {
    return BUILTIN_DEVICES[cfg.deviceDescriptor as string];
  }
  // Check by id or name
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

export function detectSafeAreaIntrusions(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const target = getDeviceTarget(capture);
  if (!target) return [];

  const findings: Finding[] = [];
  const { safeAreaInsets, notchRect } = target;

  for (const el of domSnapshot.elements) {
    const { rect, isInteractive, text, tagName } = el;
    if (rect.width <= 0 || rect.height <= 0) continue;

    // Ignore html, body, and full-bleed layout containers
    if (
      tagName.toLowerCase() === "html" ||
      tagName.toLowerCase() === "body" ||
      (rect.width >= renderConfig.width && rect.height >= renderConfig.height)
    ) {
      continue;
    }

    const hasContent = isInteractive || (text && text.trim().length > 0);
    if (!hasContent) continue;

    // 1. Check Notch / Dynamic Island Collision
    if (notchRect) {
      const collidesWithNotch =
        rect.left < notchRect.x + notchRect.width &&
        rect.right > notchRect.x &&
        rect.top < notchRect.y + notchRect.height &&
        rect.bottom > notchRect.y;

      if (collidesWithNotch) {
        findings.push({
          id: `notch-collision-${el.id || el.selector}-${renderConfig.renderId}`,
          type: "safe-area-intrusion",
          severity: "critical",
          confidence: 0.95,
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
          description: `Element <${el.tagName}> "${el.text?.slice(0, 30) || el.selector}" collides with hardware notch/cutout at [x:${notchRect.x}, y:${notchRect.y}, ${notchRect.width}x${notchRect.height}].`,
          renderId: renderConfig.renderId,
          targetId: target.id,
          device: target.name,
          fidelity: target.fidelity,
          suggestedFix:
            "Add `padding-top: max(16px, env(safe-area-inset-top))` to container or shift element below cutout boundary."
        });
        continue;
      }
    }

    // 2. Check Top/Bottom Safe Area Inset Intrusions
    if (safeAreaInsets) {
      const topIntrusion =
        safeAreaInsets.top > 0 &&
        rect.top < safeAreaInsets.top &&
        rect.bottom > 0 &&
        (isInteractive || (text && text.trim().length > 0));

      const bottomIntrusion =
        safeAreaInsets.bottom > 0 &&
        rect.bottom > renderConfig.height - safeAreaInsets.bottom &&
        rect.top < renderConfig.height &&
        isInteractive; // mainly interactive elements blocked by home indicator

      if (topIntrusion) {
        findings.push({
          id: `safe-area-top-${el.id || el.selector}-${renderConfig.renderId}`,
          type: "safe-area-intrusion",
          severity: "warning",
          confidence: 0.9,
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
          description: `Element <${el.tagName}> encroaches into top safe-area inset (y: ${Math.round(rect.top)}px < inset: ${safeAreaInsets.top}px). Content may be obscured by device status bar.`,
          renderId: renderConfig.renderId,
          targetId: target.id,
          device: target.name,
          fidelity: target.fidelity,
          suggestedFix:
            "Use `padding-top: env(safe-area-inset-top)` and ensure `viewport-fit=cover` in meta tag."
        });
      } else if (bottomIntrusion) {
        findings.push({
          id: `safe-area-bottom-${el.id || el.selector}-${renderConfig.renderId}`,
          type: "safe-area-intrusion",
          severity: "warning",
          confidence: 0.9,
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
          description: `Interactive <${el.tagName}> encroaches into bottom safe-area inset (bottom: ${Math.round(rect.bottom)}px > max safe: ${renderConfig.height - safeAreaInsets.bottom}px). May conflict with OS gesture bar.`,
          renderId: renderConfig.renderId,
          targetId: target.id,
          device: target.name,
          fidelity: target.fidelity,
          suggestedFix:
            "Add `padding-bottom: env(safe-area-inset-bottom)` to fixed/sticky bottom bars."
        });
      }
    }
  }

  return findings;
}

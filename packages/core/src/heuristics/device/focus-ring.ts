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

export function detectTvFocusRing(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const target = getDeviceTarget(capture);
  const isTV = target?.isTV ?? renderConfig.name.toLowerCase().includes("tv");
  if (!isTV) return [];

  const findings: Finding[] = [];

  const focusable = domSnapshot.elements.filter((el) => {
    const tag = el.tagName.toLowerCase();
    const isInteractive =
      tag === "button" ||
      tag === "a" ||
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      el.isInteractive;
    return isInteractive && el.rect.width > 0 && el.rect.height > 0;
  });

  for (const el of focusable) {
    const style = el.styles;
    if (!style) continue;

    // Check if outline is explicitly removed or has 0 width
    const outlineStyle = style.outlineStyle || "";
    const outlineWidth = parseFloat(style.outlineWidth || "0");
    const outlineNone = outlineStyle === "none" || outlineWidth === 0;

    // Check if box-shadow or distinct border is provided as fallback
    const boxShadow = style.boxShadow || "";
    const hasBoxShadow = boxShadow !== "" && boxShadow !== "none";
    const borderWidth = parseFloat(style.borderWidth || "0");
    const hasDistinctBorder = borderWidth >= 2;

    if (outlineNone && !hasBoxShadow && !hasDistinctBorder) {
      findings.push({
        id: `tv-no-focus-ring-${el.id || el.selector}-${renderConfig.renderId}`,
        type: "tv-missing-focus-ring",
        severity: "critical",
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
        description: `Interactive <${el.tagName}> "${el.text?.slice(0, 30) || el.selector}" lacks a visible focus indicator (outline is none/0px without contrasting border or box-shadow). On Android TV / 10-foot interfaces, users will be unable to see which element is active when using a D-pad remote.`,
        renderId: renderConfig.renderId,
        targetId: target?.id,
        device: target?.name || renderConfig.name,
        fidelity: target?.fidelity,
        suggestedFix:
          "Add an accessible focus indicator: `:focus-visible { outline: 4px solid #3b82f6; outline-offset: 4px; box-shadow: 0 0 15px rgba(59,130,246,0.6); }`."
      });
    }
  }

  return findings;
}

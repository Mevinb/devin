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

export function detectKeyboardObstruction(capture: CaptureResult): Finding[] {
  const { domSnapshot, renderConfig } = capture;
  const target = getDeviceTarget(capture);

  // Keyboard obstruction applies to mobile/tablet devices
  const isMobile = target?.isMobile ?? renderConfig.isMobile;
  if (!isMobile) return [];

  const findings: Finding[] = [];

  // Real device: use measurements taken with the actual soft keyboard open instead of simulating one.
  const probes = capture.metadata.keyboardProbes;
  if (probes && probes.length > 0) {
    for (const probe of probes.filter((p) => p.obscured)) {
      const el = domSnapshot.elements.find((e) => e.id === probe.elementId);
      findings.push({
        id: `keyboard-obstruction-${probe.elementId}-${renderConfig.renderId}`,
        type: "keyboard-obstruction",
        severity: "critical",
        confidence: 0.98,
        sources: ["heuristic"],
        bbox: el?.rect ?? { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
        elements: [{ id: probe.elementId, selector: probe.selector, tagName: el?.tagName, text: el?.text }],
        description: `With the real on-screen keyboard open, <${el?.tagName ?? "input"}> ${probe.selector} ends at ${probe.inputBottom}px but only ${probe.visibleBottom}px of the viewport remains visible — the focused field is hidden behind the keyboard.`,
        renderId: renderConfig.renderId,
        targetId: target?.id,
        device: target?.name || renderConfig.name,
        fidelity: target?.fidelity,
        suggestedFix:
          "Add `interactive-widget=resizes-content` to the viewport meta, or position the bar with `bottom: env(keyboard-inset-height, 0)` / visualViewport resize handling."
      });
    }
    return findings;
  }

  const viewportHeight = renderConfig.height;

  // Check if keyboard simulation height is explicitly passed or default to 40%
  const simulatedKeyboardHeight = Math.round(viewportHeight * 0.4);
  const keyboardTop = viewportHeight - simulatedKeyboardHeight;

  // Look for focused or active input elements, or inputs anchored to bottom without keyboard padding
  const inputElements = domSnapshot.elements.filter((el) => {
    const tag = el.tagName.toLowerCase();
    return (
      (tag === "input" || tag === "textarea" || tag === "select") &&
      el.rect.width > 0 &&
      el.rect.height > 0
    );
  });

  for (const input of inputElements) {
    // If the input or its immediate action button sits in the lower keyboard zone
    const isObstructed = input.rect.bottom > keyboardTop && input.rect.top < viewportHeight;

    let parentIsFixed = false;
    let currParentId = input.parentId;
    while (currParentId) {
      const parentEl = domSnapshot.elements.find((e) => e.id === currParentId);
      if (!parentEl) break;
      if (parentEl.styles?.position === "fixed" || parentEl.styles?.position === "sticky") {
        parentIsFixed = true;
        break;
      }
      currParentId = parentEl.parentId;
    }

    const isFixedOrSticky =
      input.styles?.position === "fixed" || input.styles?.position === "sticky" || parentIsFixed;

    if (isObstructed && isFixedOrSticky) {

      findings.push({
        id: `keyboard-obstruction-${input.id || input.selector}-${renderConfig.renderId}`,
        type: "keyboard-obstruction",
        severity: "critical",
        confidence: 0.92,
        sources: ["heuristic"],
        bbox: input.rect,
        elements: [
          {
            id: input.id,
            selector: input.selector,
            tagName: input.tagName,
            text: input.text
          }
        ],
        description: `Fixed/sticky <${input.tagName}> input sits inside the lower ${simulatedKeyboardHeight}px keyboard occlusion zone (bottom: ${Math.round(input.rect.bottom)}px > threshold: ${keyboardTop}px) and will be obscured when the on-screen keyboard appears.`,
        renderId: renderConfig.renderId,
        targetId: target?.id,
        device: target?.name || renderConfig.name,
        fidelity: target?.fidelity,
        suggestedFix:
          "Use `interactive-widget=resizes-content` in viewport meta or attach a focus listener that scrolls the input into view with `scrollIntoView({ block: 'center' })`."
      });
    }
  }

  return findings;
}

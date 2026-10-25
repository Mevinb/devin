import type { CaptureResult } from "../capture/types.js";
import type { Finding } from "./types.js";
import crypto from "node:crypto";

const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };

/** Front-end runtime errors observed while the page rendered / was interacted with on this device. */
export function detectRuntimeErrors(capture: CaptureResult): Finding[] {
  const { metadata, renderConfig } = capture;
  const target = renderConfig.deviceTarget;
  const base = {
    sources: ["heuristic" as const],
    bbox: ZERO_RECT,
    elements: [],
    renderId: renderConfig.renderId,
    targetId: target?.id,
    device: target?.name ?? renderConfig.name,
    fidelity: target?.fidelity
  };
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const push = (key: string, f: Omit<Finding, keyof typeof base | "id">) => {
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ...base, ...f, id: `runtime-${crypto.createHash("sha256").update(`${renderConfig.renderId}:${key}`).digest("hex").slice(0, 16)}` });
  };

  for (const msg of metadata.pageErrors ?? []) {
    push(`pe:${msg}`, {
      type: "runtime-error",
      severity: "critical",
      confidence: 1,
      description: `Uncaught exception: ${msg.slice(0, 300)}`,
      suggestedFix: "Fix the thrown error; check device-specific APIs (touch, visualViewport, storage) and feature detection."
    });
  }
  for (const msg of metadata.consoleErrors) {
    push(`ce:${msg}`, {
      type: "runtime-error",
      severity: "warning",
      confidence: 0.9,
      description: `console.error: ${msg.slice(0, 300)}`
    });
  }
  for (const req of metadata.failedRequests) {
    const isAsset = /\.(js|mjs|css|woff2?|ttf|png|jpe?g|webp|svg|gif)(\?|$)/i.test(req.url);
    if (/favicon\.ico/.test(req.url)) continue;
    push(`fr:${req.url}:${req.status ?? req.error}`, {
      type: "runtime-error",
      severity: isAsset || (req.status ?? 0) >= 500 ? "warning" : "info",
      confidence: 0.95,
      description: `Request failed (${req.status ?? req.error}): ${req.url}`
    });
  }
  return findings;
}

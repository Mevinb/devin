import fs from "node:fs/promises";
import path from "node:path";
import type { ScanConfig } from "../config/schema.js";
import type { Finding } from "../heuristics/types.js";
import type { CaptureResult } from "../capture/types.js";
import type { RenderReportItem, ScanReport, ScanReportSummary } from "./types.js";

export function generateScanReport(
  target: string,
  config: ScanConfig,
  results: Array<{
    capture: CaptureResult;
    findings: Finding[];
    annotatedPath: string;
    stateId?: string;
    stateName?: string;
    trace?: string[];
  }>,
  durationMs: number = 0,
  outputDir?: string
): ScanReport {
  const rel = (p: string | undefined, fallback?: string) =>
    p && outputDir ? path.relative(outputDir, p).split(path.sep).join("/") : fallback;
  const fidelityBreakdown: Record<string, number> = {};
  const defectBreakdown: Record<string, number> = {};
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let passedCount = 0;
  let failedCount = 0;

  const matrixItems: RenderReportItem[] = results.map(({ capture, findings, annotatedPath, stateId, stateName, trace }) => {
    const fidelity = capture.metadata.device?.fidelity;
    if (fidelity) fidelityBreakdown[fidelity] = (fidelityBreakdown[fidelity] || 0) + 1;
    const cCount = findings.filter((f) => f.severity === "critical").length;
    const wCount = findings.filter((f) => f.severity === "warning").length;
    const iCount = findings.filter((f) => f.severity === "info").length;

    criticalCount += cCount;
    warningCount += wCount;
    infoCount += iCount;

    for (const f of findings) {
      defectBreakdown[f.type] = (defectBreakdown[f.type] || 0) + 1;
    }

    const hasDefects = cCount > 0 || wCount > 0;
    if (hasDefects) {
      failedCount++;
    } else {
      passedCount++;
    }

    const renderId = capture.renderConfig.renderId;
    return {
      renderId,
      name: capture.renderConfig.name,
      viewport: capture.renderConfig,
      status: hasDefects ? "fail" : "pass",
      findingsCount: {
        critical: cCount,
        warning: wCount,
        info: iCount,
        total: findings.length
      },
      screenshotRelPath: rel(capture.screenshotPath, `renders/${renderId}/screenshot.png`)!,
      annotatedRelPath: rel(annotatedPath, `renders/${renderId}/annotated.png`)!,
      findings,
      consoleErrors: capture.metadata.consoleErrors,
      failedRequests: capture.metadata.failedRequests,
      device: capture.metadata.device,
      deviceScreenshotRelPath: rel(capture.metadata.deviceScreenshotPath),
      keyboardProbes: capture.metadata.keyboardProbes,
      pageErrors: capture.metadata.pageErrors,
      warnings: capture.metadata.warnings,
      stateId,
      stateName,
      trace
    };
  });

  const totalFindings = criticalCount + warningCount + infoCount;

  const summary: ScanReportSummary = {
    totalViewports: results.length,
    totalFindings,
    criticalFindings: criticalCount,
    warningFindings: warningCount,
    infoFindings: infoCount,
    passedViewports: passedCount,
    failedViewports: failedCount,
    defectBreakdown,
    durationMs,
    fidelityBreakdown: Object.keys(fidelityBreakdown).length ? fidelityBreakdown : undefined
  };
  const warnings = [...new Set(results.flatMap((r) => r.capture.metadata.warnings ?? []))];

  return {
    id: `scan-${Date.now()}`,
    timestamp: new Date().toISOString(),
    target,
    summary,
    mode: results.some((r) => r.stateId) ? "explore" : results.some((r) => r.capture.metadata.device) ? "devices" : "viewports",
    matrix: matrixItems,
    config,
    warnings: warnings.length ? warnings : undefined
  };
}

export async function writeJsonReport(
  report: ScanReport,
  outputDir: string
): Promise<string> {
  const reportPath = path.join(outputDir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}

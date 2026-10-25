import fs from "node:fs/promises";
import path from "node:path";
import { annotateScreenshot } from "./annotate/index.js";
import { CaptureRunner } from "./capture/runner.js";
import { captureSession, renderIdForTarget } from "./capture/session.js";
import type { CaptureResult } from "./capture/types.js";
import { expandMatrix } from "./config/expand.js";
import { resolveScanConfig } from "./config/loader.js";
import type { ScanConfig, ScanConfigInput } from "./config/schema.js";
import { correlateAndFuseFindings } from "./correlate/fuse.js";
import { runHeuristics } from "./heuristics/index.js";
import { detectRuntimeErrors } from "./heuristics/runtime-errors.js";
import type { DefectSeverity, Finding } from "./heuristics/types.js";
import { generateScanReport, writeHtmlReport, writeJsonReport } from "./report/index.js";
import type { ScanReport } from "./report/types.js";
import { globalDeviceRegistry, type DeviceRegistry } from "./runtime/registry.js";
import type { DeviceTarget } from "./runtime/types.js";
import { resolveTarget } from "./target/index.js";
import { bindVisionProvider, createVisionProvider } from "./vision/index.js";
import type { VisionFinding, VisionProvider } from "./vision/types.js";
import { prepareOutputDirectory } from "./output.js";
import { attachBudgetToReport, isBudgetError, RunBudget } from "./budget.js";
import type { TargetResolution } from "./target/index.js";

export interface ScanOptions {
  configFile?: string;
  visionProvider?: VisionProvider;
  registry?: DeviceRegistry;
  budget?: RunBudget;
  onProgress?: (step: string, completed: number, total: number, detail?: string) => void;
}

export interface AnalyzedCapture {
  capture: CaptureResult;
  findings: Finding[];
  annotatedPath: string;
  stateId?: string;
  stateName?: string;
  trace?: string[];
}

/** Keep post-action errors even when structural state deduplication reuses a capture. */
export async function appendRuntimeErrors(analyzed: Pick<AnalyzedCapture, "capture" | "findings">,
  errors: { consoleErrors: string[]; failedRequests: CaptureResult["metadata"]["failedRequests"]; pageErrors: string[] },
  context: Partial<Finding> = {}): Promise<void> {
  if (!errors.consoleErrors.length && !errors.failedRequests.length && !errors.pageErrors.length) return;
  const metadata = analyzed.capture.metadata;
  metadata.consoleErrors.push(...errors.consoleErrors);
  metadata.failedRequests.push(...errors.failedRequests);
  (metadata.pageErrors ??= []).push(...errors.pageErrors);
  const known = new Set(analyzed.findings.map((finding) => finding.id));
  analyzed.findings.push(...detectRuntimeErrors(analyzed.capture).filter((finding) => !known.has(finding.id)).map((finding) => ({ ...finding, renderConfig: analyzed.capture.renderConfig, ...context })));
  await fs.writeFile(analyzed.capture.metaPath, JSON.stringify(metadata, null, 2));
}

/** Heuristics -> vision -> correlation -> annotation for one capture (shared by scan and explore). */
export async function analyzeCapture(
  capture: CaptureResult,
  config: ScanConfig,
  visionProvider: VisionProvider,
  extra: Partial<Finding> = {},
  budget?: RunBudget
): Promise<AnalyzedCapture> {
  const heuristicFindings = runHeuristics(capture);
  let visionFindings: VisionFinding[] = [];
  if (config.vision.enabled) {
    if (visionProvider.warning) capture.metadata.warnings = [...(capture.metadata.warnings ?? []), visionProvider.warning];
    try {
      const analyze = () => visionProvider.analyze(capture.screenshotBuffer, {
        renderConfig: capture.renderConfig,
        domSnapshot: capture.domSnapshot,
        imageWidth: capture.metadata.screenshotGeometry?.cssWidth ?? capture.metadata.dimensions.pageWidth,
        imageHeight: capture.metadata.screenshotGeometry?.cssHeight ?? capture.metadata.dimensions.pageHeight,
        originX: capture.metadata.screenshotGeometry?.originX,
        originY: capture.metadata.screenshotGeometry?.originY
      }, { signal: budget?.signal });
      const visionResult = budget ? await budget.run(analyze) : await analyze();
      visionFindings = visionResult.findings;
    } catch (err) {
      const key = process.env.OPENAI_API_KEY;
      const detail = key ? (err as Error).message.replaceAll(key, "[redacted]") : (err as Error).message;
      const warning = `Vision analysis failed for ${capture.renderConfig.renderId}: ${detail}`;
      capture.metadata.warnings = [...(capture.metadata.warnings ?? []), warning];
      console.warn(warning);
    }
  }
  const target = capture.renderConfig.deviceTarget;
  const findings = correlateAndFuseFindings(capture, heuristicFindings, visionFindings).map((f) => ({
    ...f,
    renderConfig: capture.renderConfig,
    elements: f.elements.map((el) => ({ ...el, source: capture.domSnapshot.elements.find((node) => node.selector === el.selector)?.source })),
    targetId: f.targetId ?? target?.id,
    device: f.device ?? target?.name,
    fidelity: capture.metadata.device?.fidelity ?? f.fidelity,
    ...extra
  }));
  const annotatedPath = path.join(path.dirname(capture.screenshotPath), "annotated.png");
  await annotateScreenshot(capture.screenshotBuffer, findings, annotatedPath, capture.metadata.screenshotGeometry ?? capture.metadata.dimensions.pageWidth);
  await fs.writeFile(capture.metaPath, JSON.stringify(capture.metadata, null, 2));
  return { capture, findings, annotatedPath };
}

const SEVERITY_RANK: Record<DefectSeverity, number> = { info: 1, warning: 2, critical: 3 };

/**
 * Whether the report should fail CI. `approximate` renders don't fail by default because they are
 * emulations, not the real device.
 */
export function reportFails(
  report: ScanReport,
  failOn: DefectSeverity | "none" = "critical",
  includeApproximate = false
): boolean {
  if (report.errors?.length) return true;
  if (failOn === "none") return false;
  return report.matrix.some((item) =>
    item.findings.some(
      (f) =>
        SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn] &&
        (includeApproximate || item.device?.fidelity !== "approximate" || !item.device)
    )
  );
}

export function resolveDeviceTargets(config: ScanConfig, registry: DeviceRegistry = globalDeviceRegistry): DeviceTarget[] {
  return (config.devices ?? []).map((d) => registry.resolveTarget(d as string | DeviceTarget));
}

export async function scan(
  input: Partial<ScanConfigInput>,
  options: ScanOptions = {}
): Promise<ScanReport> {
  const startTime = Date.now();
  const config = await resolveScanConfig(input, options.configFile);
  const outputDir = path.resolve(process.cwd(), config.output.dir);
  const registry = options.registry ?? globalDeviceRegistry;
  const budget = options.budget ?? new RunBudget(config.budget);
  const captureRunner = new CaptureRunner();
  const detachCaptureAbort = budget.onAbort(() => captureRunner.close());
  const captures: CaptureResult[] = [];
  const errors: NonNullable<ScanReport["errors"]> = [];
  let targetResolution: TargetResolution | undefined;
  const deviceTargets = resolveDeviceTargets(config, registry);
  try {
    await prepareOutputDirectory(outputDir, config.target, config.output.clean);
    const visionProvider = bindVisionProvider(options.visionProvider ?? createVisionProvider(config.vision, budget), budget);
    try {
      budget.assertActive();
      options.onProgress?.("target", 0, 1, `Resolving target ${config.target}`);
      targetResolution = await budget.run(() => resolveTarget(config, undefined, budget.signal), (late) => late.cleanup());
      if (deviceTargets.length > 0) {
        const queue = deviceTargets.map((t, i) => ({ t, i }));
        const ordered: Array<CaptureResult | undefined> = [];
        let done = 0;
        const worker = async () => {
          for (let item = queue.shift(); item; item = queue.shift()) {
            budget.assertActive();
            const { t, i } = item;
            options.onProgress?.("capture", done, deviceTargets.length, `Launching ${t.name}`);
            let session: Awaited<ReturnType<ReturnType<DeviceRegistry["getRuntime"]>["launch"]>> | undefined;
            let detachAbort: (() => void) | undefined;
            try {
              session = await budget.run(() => registry.getRuntime(t.runtime).launch(t), (late) => late.close());
              detachAbort = budget.onAbort(() => session!.page.close());
              ordered[i] = await budget.run(() => captureSession(session!, targetResolution!.url, config, outputDir, renderIdForTarget(t)));
            } catch (err) {
              if (isBudgetError(err) || budget.signal.aborted) throw err;
              errors.push({ targetId: t.id, message: (err as Error).message });
            } finally { detachAbort?.(); await session?.close(); }
            done++;
            options.onProgress?.("capture", done, deviceTargets.length, ordered[i] ? `Captured ${t.name} (${session!.target.fidelity})` : `Capture failed on ${t.name}`);
          }
        };
        const workers = await Promise.allSettled(Array.from({ length: Math.min(config.concurrency, deviceTargets.length) }, worker));
        captures.push(...ordered.filter((capture): capture is CaptureResult => Boolean(capture)));
        const failed = workers.find((worker) => worker.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } else {
        const renderConfigs = expandMatrix(config);
        options.onProgress?.("matrix", 0, renderConfigs.length, `Expanded into ${renderConfigs.length} viewports`);
        await budget.run(() => captureRunner.captureAll(targetResolution!.url, renderConfigs, config, outputDir, (completed, total, renderId) => {
          options.onProgress?.("capture", completed, total, `Captured ${renderId}`);
        }, (capture) => captures.push(capture)));
      }
    } catch (error) {
      if (!isBudgetError(error) && !budget.signal.aborted) throw error;
    }
    // Retain completed captures even after a stop. Report/annotation cleanup may
    // run afterwards, but no further device actions or paid analysis may start.
    const results: AnalyzedCapture[] = [];
    for (const [i, capture] of captures.entries()) {
      options.onProgress?.("analysis", i, captures.length, `Analyzing ${capture.renderConfig.name}`);
      const stopped = budget.snapshot().stopped;
      if (stopped) (capture.metadata.warnings ??= []).push(`Paid analysis skipped: ${stopped.message}`);
      else budget.claimState("initial");
      const analyzed = await analyzeCapture(capture, stopped ? { ...config, vision: { ...config.vision, enabled: false } } : config, visionProvider, {}, budget);
      results.push(analyzed);
      options.onProgress?.("analysis", i + 1, captures.length, `Analyzed ${capture.renderConfig.name} (${analyzed.findings.length} findings)`);
    }
    const report = generateScanReport(config.target, config, results, Date.now() - startTime, outputDir);
    if (errors.length) {
      report.errors = errors;
      report.summary.totalViewports += errors.length; report.summary.failedViewports += errors.length;
      report.warnings = [...(report.warnings ?? []), ...errors.map((error) => `${error.targetId}: capture failed: ${error.message}`)];
    }
    attachBudgetToReport(report, budget);
    if (config.output.json) await writeJsonReport(report, outputDir);
    if (config.output.html) await writeHtmlReport(report, outputDir);
    options.onProgress?.("report", 1, 1, `Report saved to ${outputDir}`);
    return report;
  } finally {
    detachCaptureAbort(); await captureRunner.close();
    if (deviceTargets.length > 0 && !options.registry) await registry.shutdownAll();
    await targetResolution?.cleanup();
    if (!options.budget) budget.dispose();
  }
}

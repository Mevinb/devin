import fs from "node:fs/promises";
import path from "node:path";
import { annotateScreenshot } from "./annotate/index.js";
import { CaptureRunner } from "./capture/runner.js";
import type { CaptureResult } from "./capture/types.js";
import { expandMatrix } from "./config/expand.js";
import { resolveScanConfig } from "./config/loader.js";
import type { ScanConfig, ScanConfigInput } from "./config/schema.js";
import { correlateAndFuseFindings } from "./correlate/fuse.js";
import { runHeuristics } from "./heuristics/index.js";
import type { Finding } from "./heuristics/types.js";
import { generateScanReport, writeHtmlReport, writeJsonReport } from "./report/index.js";
import type { ScanReport } from "./report/types.js";
import { resolveTarget } from "./target/index.js";
import { createVisionProvider } from "./vision/index.js";
import type { VisionProvider } from "./vision/types.js";

export interface ScanOptions {
  configFile?: string;
  visionProvider?: VisionProvider;
  onProgress?: (step: string, completed: number, total: number, detail?: string) => void;
}

export async function scan(
  input: Partial<ScanConfigInput>,
  options: ScanOptions = {}
): Promise<ScanReport> {
  const startTime = Date.now();
  const config = await resolveScanConfig(input, options.configFile);
  const outputDir = path.resolve(process.cwd(), config.output.dir);

  if (config.output.clean) {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
  await fs.mkdir(outputDir, { recursive: true });

  options.onProgress?.("target", 0, 1, `Resolving target ${config.target}`);
  const targetResolution = await resolveTarget(config);

  const captureRunner = new CaptureRunner();
  const visionProvider = options.visionProvider || createVisionProvider(config.vision);

  try {
    const renderConfigs = expandMatrix(config);
    options.onProgress?.("matrix", 0, renderConfigs.length, `Expanded into ${renderConfigs.length} viewports`);

    // Capture all viewports
    const captures = await captureRunner.captureAll(
      targetResolution.url,
      renderConfigs,
      config,
      outputDir,
      (completed, total, renderId) => {
        options.onProgress?.("capture", completed, total, `Captured ${renderId}`);
      }
    );

    // Analyze each render
    const results: Array<{
      capture: CaptureResult;
      findings: Finding[];
      annotatedPath: string;
    }> = [];

    let analyzedCount = 0;
    for (const capture of captures) {
      options.onProgress?.(
        "analysis",
        analyzedCount,
        captures.length,
        `Analyzing ${capture.renderConfig.name}`
      );

      // Run heuristics
      const heuristicFindings = runHeuristics(capture);

      // Run vision analysis if enabled
      let visionFindings: import("./vision/types.js").VisionFinding[] = [];
      if (config.vision.enabled) {
        try {
          const visionResult = await visionProvider.analyze(capture.screenshotBuffer, {
            renderConfig: capture.renderConfig,
            domSnapshot: capture.domSnapshot,
            imageWidth: capture.metadata.dimensions.viewportWidth,
            imageHeight: capture.metadata.dimensions.pageHeight
          });
          visionFindings = visionResult.findings;
        } catch (err) {
          console.warn(`Vision analysis failed for ${capture.renderConfig.renderId}:`, err);
        }
      }

      // Correlate and fuse findings
      const fusedFindings = correlateAndFuseFindings(
        capture,
        heuristicFindings,
        visionFindings
      );

      // Annotate screenshot
      const renderDir = path.dirname(capture.screenshotPath);
      const annotatedPath = path.join(renderDir, "annotated.png");
      await annotateScreenshot(capture.screenshotBuffer, fusedFindings, annotatedPath);

      results.push({
        capture,
        findings: fusedFindings,
        annotatedPath
      });

      analyzedCount++;
      options.onProgress?.(
        "analysis",
        analyzedCount,
        captures.length,
        `Analyzed ${capture.renderConfig.name} (${fusedFindings.length} findings)`
      );
    }

    // Build and save reports
    const durationMs = Date.now() - startTime;
    const report = generateScanReport(config.target, config, results, durationMs);

    if (config.output.json) {
      await writeJsonReport(report, outputDir);
    }

    if (config.output.html) {
      await writeHtmlReport(report, outputDir);
    }

    options.onProgress?.("report", 1, 1, `Report saved to ${outputDir}`);
    return report;
  } finally {
    await captureRunner.close();
    await targetResolution.cleanup();
  }
}

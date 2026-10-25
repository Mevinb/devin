import fs from "node:fs/promises";
import path from "node:path";
import { resolveScanConfig } from "../config/loader.js";
import type { ScanConfigInput } from "../config/schema.js";
import { generateScanReport, writeHtmlReport, writeJsonReport } from "../report/index.js";
import type { ScanReport } from "../report/types.js";
import { globalDeviceRegistry, type DeviceRegistry } from "../runtime/registry.js";
import type { DeviceTarget } from "../runtime/types.js";
import { resolveDeviceTargets, type AnalyzedCapture } from "../scanner.js";
import { resolveTarget } from "../target/index.js";
import { createVisionProvider } from "../vision/index.js";
import type { VisionProvider } from "../vision/types.js";
import { ReplayEngine } from "./replay.js";
import { PilotThenReplayScheduler, type MultiDeviceExploreResult } from "./scheduler.js";
import type { ExploreConfig, ExploreProgressEvent } from "./types.js";
import { parseReplayTrace } from "./trace.js";
import { ExploreConfigSchema } from "./config.js";
import { prepareOutputDirectory } from "../output.js";
import { attachBudgetToReport, isBudgetError, RunBudget } from "../budget.js";
import type { TargetResolution } from "../target/index.js";

export const DEFAULT_EXPLORE_DEVICES = ["android:pixel-8", "chromium:desktop-1080p", "webkit:iphone-15-pro"];

export interface ExploreRunOptions {
  configFile?: string;
  visionProvider?: VisionProvider;
  registry?: DeviceRegistry;
  onProgress?: (e: ExploreProgressEvent) => void;
  budget?: RunBudget;
}

export interface ExploreRunResult {
  report: ScanReport;
  result: MultiDeviceExploreResult;
  outputDir: string;
}

/** `scan --explore`: discover states with the agent on a pilot device, replay them everywhere, report. */
export async function explore(
  input: Partial<ScanConfigInput>,
  exploreConfig: Partial<ExploreConfig> = {},
  options: ExploreRunOptions = {}
): Promise<ExploreRunResult> {
  exploreConfig = ExploreConfigSchema.parse(exploreConfig);
  const started = Date.now();
  const config = await resolveScanConfig(input, options.configFile);
  const outputDir = path.resolve(process.cwd(), config.output.dir);
  const registry = options.registry ?? globalDeviceRegistry;
  const budget = options.budget ?? new RunBudget(config.budget);
  await prepareOutputDirectory(outputDir, config.target, config.output.clean);

  const devices: DeviceTarget[] = config.devices?.length
    ? resolveDeviceTargets(config, registry)
    : DEFAULT_EXPLORE_DEVICES.map((id) => registry.resolveTarget(id));

  let target: TargetResolution | undefined;
  let result: MultiDeviceExploreResult = { trace: { traceId: "not-started", pilotTarget: devices[0], steps: [], discoveredStates: [], startTime: new Date(started).toISOString(), endTime: new Date().toISOString() },
    states: [], matrix: [], allFindings: [], analyzed: [], replays: [], agentCalls: 0, tokensUsed: 0, warnings: [], errors: [] };
  try {
    try {
    budget.constrain({ maxMinutes: exploreConfig.maxMinutes, maxStates: exploreConfig.maxStates ?? 10 });
    target = await budget.run(() => resolveTarget(config, undefined, budget.signal), (late) => late.cleanup());
    result = await new PilotThenReplayScheduler(registry).run(target.url, devices, exploreConfig, outputDir, {
      scanConfig: config,
      visionProvider: options.visionProvider ?? createVisionProvider(config.vision, budget),
      budget,
      onProgress: options.onProgress
    });
    } catch (error) {
      if (!isBudgetError(error) && !budget.signal.aborted) throw error;
      result.errors.push({ targetId: "budget", message: budget.snapshot().stopped?.message ?? (error as Error).message });
    }
    const report = generateScanReport(config.target, config, result.analyzed, Date.now() - started, outputDir);
    report.mode = "explore";
    if (result.errors.length) report.errors = result.errors;
    report.summary.statesDiscovered = new Set(result.analyzed.map((item) => item.stateId)).size;
    report.summary.agentCalls = result.agentCalls;
    report.summary.agentTokens = result.tokensUsed;
    report.warnings = [...new Set([...(report.warnings ?? []), ...result.warnings])];
    attachBudgetToReport(report, budget);
    if (config.output.json) await writeJsonReport(report, outputDir);
    if (config.output.html) await writeHtmlReport(report, outputDir);
    return { report, result, outputDir };
  } finally {
    if (!options.registry) await registry.shutdownAll();
    await target?.cleanup();
    if (!options.budget) budget.dispose();
  }
}

/** `pixelsentinel replay <trace.json>`: re-run a recorded exploration on other devices. */
export async function replayTrace(
  tracePath: string,
  input: Partial<ScanConfigInput>,
  exploreConfig: Partial<ExploreConfig> = {},
  options: ExploreRunOptions = {}
): Promise<ScanReport> {
  exploreConfig = ExploreConfigSchema.parse(exploreConfig);
  const started = Date.now();
  const trace = parseReplayTrace(JSON.parse(await fs.readFile(tracePath, "utf8")));
  const config = await resolveScanConfig(input, options.configFile);
  const outputDir = path.resolve(process.cwd(), config.output.dir);
  const registry = options.registry ?? globalDeviceRegistry;
  const budget = options.budget ?? new RunBudget(config.budget);
  await prepareOutputDirectory(outputDir, config.target, false);
  const devices = config.devices?.length ? resolveDeviceTargets(config, registry) : [trace.pilotTarget];
  let target: TargetResolution | undefined;
  const vision = options.visionProvider ?? createVisionProvider(config.vision, budget);
  const analyzed: AnalyzedCapture[] = [];
  const warnings: string[] = [];
  const errors: NonNullable<ScanReport["errors"]> = [];
  let agentCalls = 0, agentTokens = 0;
  try {
    try {
    budget.constrain({ maxMinutes: exploreConfig.maxMinutes, maxStates: exploreConfig.maxStates ?? (trace.discoveredStates.length || 1) });
    target = await budget.run(() => resolveTarget(config, undefined, budget.signal), (late) => late.cleanup());
    for (const device of devices) {
      budget.assertActive();
      let session;
      try { session = await budget.run(() => registry.getRuntime(device.runtime).launch(device), (late) => late.close()); }
      catch (error) { errors.push({ targetId: device.id, message: (error as Error).message.split("\n")[0] }); continue; }
      warnings.push(...session.warnings);
      try {
        const res = await new ReplayEngine().replayTraceOnSession(trace, session, target.url, {
          outputDir,
          scanConfig: config,
          visionProvider: vision,
          exploreConfig,
          onProgress: options.onProgress,
          budget
        });
        analyzed.push(...res.stateResults);
        agentCalls += res.agentCalls; agentTokens += res.tokensUsed;
        if (!res.success) errors.push({ targetId: device.id, message: `Replay diverged at step ${res.divergedAtStep}: ${res.message ?? "recorded state could not be reached"}` });
      } finally {
        await session.close();
      }
    }
    } catch (error) {
      if (!isBudgetError(error) && !budget.signal.aborted) throw error;
      errors.push({ targetId: "budget", message: budget.snapshot().stopped?.message ?? (error as Error).message });
    }
    const report = generateScanReport(config.target, config, analyzed, Date.now() - started, outputDir);
    report.mode = "explore";
    report.summary.agentCalls = agentCalls; report.summary.agentTokens = agentTokens;
    report.summary.statesDiscovered = new Set(analyzed.map((item) => item.stateId)).size;
    if (errors.length) report.errors = errors;
    report.warnings = [...new Set([...(report.warnings ?? []), ...warnings])];
    attachBudgetToReport(report, budget);
    await writeJsonReport(report, outputDir);
    await writeHtmlReport(report, outputDir);
    return report;
  } finally {
    if (!options.registry) await registry.shutdownAll();
    await target?.cleanup();
    if (!options.budget) budget.dispose();
  }
}

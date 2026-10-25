import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  attachPageMonitor,
  captureCurrentState,
  renderIdForTarget,
  snapshotPage,
  stabilizePage
} from "../capture/session.js";
import type { CaptureResult } from "../capture/types.js";
import { ScanConfigSchema, type ScanConfig } from "../config/schema.js";
import type { Finding } from "../heuristics/types.js";
import { globalDeviceRegistry, type DeviceRegistry } from "../runtime/registry.js";
import type { DeviceSession, DeviceTarget } from "../runtime/types.js";
import { analyzeCapture, appendRuntimeErrors, type AnalyzedCapture } from "../scanner.js";
import { MockVisionProvider } from "../vision/mock-provider.js";
import { bindVisionProvider } from "../vision/index.js";
import type { VisionProvider } from "../vision/types.js";
import { ExplorationAgent } from "./agent.js";
import { computeStateFingerprint } from "./fingerprint.js";
import { describeAction, ReplayEngine, type ReplayResult } from "./replay.js";
import { executeAction } from "./tools.js";
import { ActionPolicy } from "./policy.js";
import { isBudgetError, isStateLimit, RunBudget } from "../budget.js";
import type {
  AgentAction,
  DiscoveredState,
  ExploreConfig,
  ExploreProgressEvent,
  ExplorationStep,
  ExplorationTrace
} from "./types.js";

export interface DeviceStateMatrixEntry {
  deviceId: string;
  deviceName: string;
  stateId: string;
  stateName: string;
  fidelity: "real" | "webview" | "approximate";
  captureResult: CaptureResult;
  findings: Finding[];
}

export interface MultiDeviceExploreResult {
  trace: ExplorationTrace;
  states: DiscoveredState[];
  matrix: DeviceStateMatrixEntry[];
  allFindings: Finding[];
  /** Same entries in the shape used by report generation. */
  analyzed: AnalyzedCapture[];
  replays: Array<Pick<ReplayResult, "targetId" | "success" | "divergedAtStep" | "recoveries" | "agentCalls">>;
  agentCalls: number;
  tokensUsed: number;
  warnings: string[];
  errors: Array<{ targetId: string; message: string }>;
}

export interface SchedulerRunOptions {
  scanConfig?: ScanConfig;
  visionProvider?: VisionProvider;
  onProgress?: (e: ExploreProgressEvent) => void;
  budget?: RunBudget;
}

/** Strip buffers so the trace can be persisted and replayed later (`pixelsentinel replay`). */
export function serializableTrace(trace: ExplorationTrace): unknown {
  return {
    ...trace,
    discoveredStates: trace.discoveredStates.map(({ captureResult, findings, ...rest }) => ({
      ...rest,
      screenshotPath: captureResult.screenshotPath,
      findingCount: findings.length
    }))
  };
}

export class PilotThenReplayScheduler {
  constructor(
    private readonly registry: DeviceRegistry = globalDeviceRegistry,
    private readonly replayEngine: ReplayEngine = new ReplayEngine()
  ) {}

  /** Agent-driven exploration on one session. Every new state goes through the full analysis pipeline. */
  async exploreSession(
    session: DeviceSession,
    targetUrl: string,
    config: Partial<ExploreConfig>,
    outputDir: string,
    scanConfig: ScanConfig,
    vision: VisionProvider,
    stateIds: Map<string, string>,
    budget: RunBudget,
    onProgress?: (e: ExploreProgressEvent) => void
  ): Promise<{ steps: ExplorationStep[]; states: DiscoveredState[]; agent: ExplorationAgent; stopReason?: string }> {
    const target = session.target;
    const agent = new ExplorationAgent(config, budget);
    const steps: ExplorationStep[] = [];
    const states: DiscoveredState[] = [];
    const executed: string[] = [];
    const executedActions: AgentAction[] = [];
    const detachAbort = budget.onAbort(() => session.page.close());
    const monitor = attachPageMonitor(session.page);
    let detachPolicy: (() => Promise<void>) | undefined;
    let currentState: DiscoveredState | undefined;
    let stopReason: string | undefined;
    let pendingTransition = false;

    try {
      const url = session.prepareUrl ? await session.prepareUrl(targetUrl) : targetUrl;
      const policy = new ActionPolicy(url, config);
      detachPolicy = await policy.attach(session.page);
      await session.page.goto(url, { waitUntil: scanConfig.waitUntil, timeout: 60000 });
      await stabilizePage(session.page, scanConfig.extraWaitMs);

      const maxSteps = config.maxSteps || 20;
      for (let i = 0; i <= maxSteps; i++) {
        budget.assertActive();
        const snap = await snapshotPage(session.page);
        const currentUrl = session.page.url();
        const { fingerprint, name } = computeStateFingerprint(snap, currentUrl);
        let stateId = stateIds.get(fingerprint);
        const isNew = !stateId || !states.some((s) => s.stateId === stateId);
        if (!stateId) {
          stateId = `state-${stateIds.size + 1}`;
          budget.claimState(stateId);
          stateIds.set(fingerprint, stateId);
        }
        const errors = monitor.drain();

        if (isNew) {
          const renderId = renderIdForTarget(target, stateId);
          const capture = await captureCurrentState({
            session,
            renderId,
            renderDir: path.join(outputDir, "renders", renderId),
            url: currentUrl,
            fullPage: scanConfig.fullPage,
            monitor: errors,
            snapshot: snap
          });
          const analyzed = await analyzeCapture(capture, scanConfig, vision, {
            stateId,
            trace: [...executed],
            actions: [...executedActions]
          }, budget);
          states.push({
            stateId,
            name,
            fingerprint,
            url: currentUrl,
            stepIndex: i,
            captureResult: capture,
            findings: analyzed.findings,
            annotatedPath: analyzed.annotatedPath,
            trace: [...executed]
          });
          onProgress?.({
            phase: "pilot",
            deviceId: target.id,
            step: i,
            stateId,
            stateName: name,
            screenshotPath: capture.screenshotPath,
            agentCalls: agent.llmCalls,
            tokensUsed: agent.tokensUsed
          });
        }
        currentState = states.find((state) => state.stateId === stateId);
        if (!isNew && currentState) await appendRuntimeErrors({ capture: currentState.captureResult, findings: currentState.findings }, errors,
          { stateId, trace: [...executed], actions: [...executedActions] });
        if (steps.length > 0) steps[steps.length - 1].stateAfter = stateId;
        pendingTransition = false;

        if (i === maxSteps || states.length >= Math.min(config.maxStates ?? 10, budget.config.maxStates ?? Infinity)) break;

        const shot = await session.control.captureScreenshot();
        const observationPath = path.join(outputDir, "explore", "observations", renderIdForTarget(target), `step-${i}.png`);
        await fs.mkdir(path.dirname(observationPath), { recursive: true });
        await fs.writeFile(observationPath, shot);
        const action = await agent.decideNextAction(snap, shot.toString("base64"), currentUrl, fingerprint, {
          history: executed,
          isTV: target.isTV
        });
        const step: ExplorationStep = {
          stepIndex: i,
          action,
          stateBefore: stateId,
          stateAfter: stateId,
          timestamp: new Date().toISOString()
        };
        if (action.type !== "done") budget.consumeAction();
        steps.push(step);
        onProgress?.({ phase: "pilot", deviceId: target.id, step: i, action, stateId, screenshotPath: observationPath, agentCalls: agent.llmCalls, tokensUsed: agent.tokensUsed });
        if (action.type === "done") break;
        pendingTransition = true;
        const result = await executeAction(session, action, snap, policy);
        step.details = result.details;
        if (result.success) {
          executed.push(describeAction(action));
          executedActions.push(action);
        } else step.failed = true;
      }
    } catch (error) {
      if (!isBudgetError(error) && !isStateLimit(error) && !budget.signal.aborted) throw error;
      if (pendingTransition) steps.pop();
      stopReason = budget.snapshot().stopped?.message ?? (error as Error).message;
    } finally {
      try {
        if (currentState) await appendRuntimeErrors({ capture: currentState.captureResult, findings: currentState.findings }, monitor.drain(),
          { stateId: currentState.stateId, trace: [...executed], actions: [...executedActions] });
      } finally { monitor.detach(); detachAbort(); await detachPolicy?.(); }
    }
    return { steps, states, agent, stopReason };
  }

  async run(
    targetUrl: string,
    targets: DeviceTarget[],
    config: Partial<ExploreConfig> = {},
    outputDir = "./pixelsentinel-output",
    options: SchedulerRunOptions = {}
  ): Promise<MultiDeviceExploreResult> {
    if (targets.length === 0) {
      throw new Error("At least one device target is required for exploration.");
    }
    const scanConfig = options.scanConfig ?? ScanConfigSchema.parse({ target: targetUrl, vision: { enabled: false } });
    const budget = options.budget ?? new RunBudget(scanConfig.budget);
    budget.constrain({ maxMinutes: config.maxMinutes, maxStates: config.maxStates ?? 10 });
    try {
    const vision = bindVisionProvider(options.visionProvider ?? new MockVisionProvider([]), budget);
    const absOut = path.resolve(outputDir);
    await fs.mkdir(path.join(absOut, "explore"), { recursive: true });

    const pilotTarget = targets.find((t) => t.id === config.pilotDevice) || targets[0];
    const secondaryTargets = targets.filter((t) => t !== pilotTarget);
    const warnings: string[] = [];
    const errors: MultiDeviceExploreResult["errors"] = [];
    if (!config.useMockAgent && !process.env.OPENAI_API_KEY) {
      warnings.push("OpenAI exploration was requested but OPENAI_API_KEY is not configured; the offline exploration agent was used.");
    }
    const stateIds = new Map<string, string>();
    const startTime = new Date().toISOString();

    // Step 1: pilot exploration
    const pilotSession = await budget.run(() => this.registry.getRuntime(pilotTarget.runtime).launch(pilotTarget), (late) => late.close());
    warnings.push(...pilotSession.warnings);
    let pilot: Awaited<ReturnType<PilotThenReplayScheduler["exploreSession"]>>;
    let pilotResolved: DeviceTarget;
    try {
      pilot = await this.exploreSession(pilotSession, targetUrl, config, absOut, scanConfig, vision, stateIds, budget, options.onProgress);
      pilotResolved = pilotSession.target;
    } finally {
      await pilotSession.close();
    }
    if (pilot.stopReason) warnings.push(pilot.stopReason);

    const trace: ExplorationTrace = {
      traceId: `trace-${crypto.randomUUID().slice(0, 8)}`,
      pilotTarget: pilotResolved,
      steps: pilot.steps,
      discoveredStates: pilot.states,
      startTime,
      endTime: new Date().toISOString(),
      startUrl: targetUrl
    };
    await fs.writeFile(path.join(absOut, "explore", "trace.json"), JSON.stringify(serializableTrace(trace), null, 2));

    const analyzed: AnalyzedCapture[] = pilot.states.map((s) => ({
      capture: s.captureResult,
      findings: s.findings,
      annotatedPath: s.annotatedPath!,
      stateId: s.stateId,
      stateName: s.name,
      trace: s.trace
    }));
    const stateNames = new Map(pilot.states.map((s) => [s.stateId, s.name]));
    const replays: MultiDeviceExploreResult["replays"] = [];
    let agentCalls = pilot.agent.llmCalls;
    let tokensUsed = pilot.agent.tokensUsed;

    // Step 2: replay on the other devices (or full exploration per device)
    for (const target of secondaryTargets) {
      if (budget.snapshot().stopped) break;
      let session: DeviceSession;
      try { session = await budget.run(() => this.registry.getRuntime(target.runtime).launch(target), (late) => late.close()); }
      catch (error) { errors.push({ targetId: target.id, message: (error as Error).message.split("\n")[0] }); continue; }
      warnings.push(...session.warnings);
      try {
        if (config.perDevice) {
          const res = await this.exploreSession(session, targetUrl, config, absOut, scanConfig, vision, stateIds, budget, options.onProgress);
          agentCalls += res.agent.llmCalls;
          tokensUsed += res.agent.tokensUsed;
          for (const s of res.states) {
            if (!stateNames.has(s.stateId)) stateNames.set(s.stateId, s.name);
            analyzed.push({
              capture: s.captureResult,
              findings: s.findings,
              annotatedPath: s.annotatedPath!,
              stateId: s.stateId,
              stateName: stateNames.get(s.stateId),
              trace: s.trace
            });
          }
          replays.push({ targetId: target.id, success: !res.stopReason, recoveries: 0, agentCalls: res.agent.llmCalls });
          if (res.stopReason) errors.push({ targetId: target.id, message: res.stopReason });
        } else {
          const res = await this.replayEngine.replayTraceOnSession(trace, session, targetUrl, {
            outputDir: absOut,
            scanConfig,
            visionProvider: vision,
            exploreConfig: config,
            onProgress: options.onProgress,
            budget
          });
          agentCalls += res.agentCalls;
          tokensUsed += res.tokensUsed;
          analyzed.push(...res.stateResults);
          replays.push({
            targetId: target.id,
            success: res.success,
            divergedAtStep: res.divergedAtStep,
            recoveries: res.recoveries,
            agentCalls: res.agentCalls
          });
          if (!res.success) {
            const message = `Replay diverged at step ${res.divergedAtStep}: ${res.message ?? "recorded state could not be reached"}; later states not captured`;
            warnings.push(`${target.id}: ${message}`);
            errors.push({ targetId: target.id, message });
          }
        }
      } catch (err) {
        warnings.push(`${target.id}: exploration failed: ${(err as Error).message.split("\n")[0]}`);
        errors.push({ targetId: target.id, message: (err as Error).message.split("\n")[0] });
      } finally {
        await session.close();
      }
    }

    const matrix: DeviceStateMatrixEntry[] = analyzed.map((a) => ({
      deviceId: a.capture.metadata.device?.id ?? a.capture.renderConfig.renderId,
      deviceName: a.capture.renderConfig.name,
      stateId: a.stateId!,
      stateName: a.stateName ?? a.stateId!,
      fidelity: a.capture.metadata.device?.fidelity ?? "approximate",
      captureResult: a.capture,
      findings: a.findings
    }));

    return {
      trace,
      states: pilot.states,
      matrix,
      allFindings: analyzed.flatMap((a) => a.findings),
      analyzed,
      replays,
      agentCalls,
      tokensUsed,
      warnings: [...new Set(warnings)],
      errors
    };
    } finally { if (!options.budget) budget.dispose(); }
  }
}

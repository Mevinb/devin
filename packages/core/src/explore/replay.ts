import path from "node:path";
import fs from "node:fs/promises";
import {
  attachPageMonitor,
  captureCurrentState,
  renderIdForTarget,
  snapshotPage,
  stabilizePage
} from "../capture/session.js";
import type { ScanConfig } from "../config/schema.js";
import type { DeviceSession } from "../runtime/types.js";
import { analyzeCapture, appendRuntimeErrors, type AnalyzedCapture } from "../scanner.js";
import type { VisionProvider } from "../vision/types.js";
import { bindVisionProvider } from "../vision/index.js";
import { ExplorationAgent } from "./agent.js";
import { computeStateFingerprint } from "./fingerprint.js";
import { executeAction } from "./tools.js";
import { ActionPolicy } from "./policy.js";
import type { AgentAction, ExploreConfig, ExploreProgressEvent, ExplorationStep, ReplayableTrace } from "./types.js";
import { rebaseTraceAction, rebaseTraceUrl } from "./trace.js";
import { RunBudget } from "../budget.js";

export interface ReplayStateResult extends AnalyzedCapture {
  stateId: string;
  targetId: string;
  fingerprint: string;
}

export interface ReplayResult {
  traceId: string;
  targetId: string;
  success: boolean;
  stateResults: ReplayStateResult[];
  divergedAtStep?: number;
  recoveries: number;
  agentCalls: number;
  tokensUsed: number;
  message?: string;
}

export function describeAction(a: AgentAction): string {
  switch (a.type) {
    case "tap":
      return `tap ${a.selector ?? a.elementId}${a.description ? ` (${a.description})` : ""}`;
    case "type":
      return `type "${a.text}" into ${a.selector ?? a.elementId}`;
    case "scroll":
    case "swipe":
      return `${a.type} ${a.direction} ${a.amount ?? ""}`.trim();
    case "press_key":
      return `press ${a.key}`;
    case "rotate":
      return `rotate ${a.orientation}`;
    case "set_posture":
      return `set posture ${a.posture}`;
    case "navigate":
      return `navigate ${a.url}`;
    case "back":
      return "back";
    case "done":
      return `done: ${a.reason}`;
  }
}

export interface ReplayOptions {
  outputDir: string;
  scanConfig: ScanConfig;
  visionProvider: VisionProvider;
  exploreConfig?: Partial<ExploreConfig>;
  onProgress?: (e: ExploreProgressEvent) => void;
  budget?: RunBudget;
}

export class ReplayEngine {
  /**
   * Deterministically replay the pilot's action trace on another device. When a step cannot be executed
   * (e.g. the target lives behind a collapsed mobile menu), the agent is re-invoked with the step as a
   * goal for up to `maxRecoverySteps` actions before the replay is declared diverged.
   */
  async replayTraceOnSession(
    trace: ReplayableTrace,
    session: DeviceSession,
    startUrl: string,
    opts: ReplayOptions
  ): Promise<ReplayResult> {
    const { page } = session;
    const budget = opts.budget ?? new RunBudget(opts.scanConfig.budget);
    const vision = bindVisionProvider(opts.visionProvider, budget);
    budget.constrain({ maxMinutes: opts.exploreConfig?.maxMinutes });
    const detachAbort = budget.onAbort(() => page.close());
    const target = session.target;
    const stateResults: ReplayStateResult[] = [];
    const seen = new Set<string>();
    const agent = new ExplorationAgent({ ...opts.exploreConfig, maxSteps: 1000, maxStates: 1000 }, budget);
    const maxRecovery = opts.exploreConfig?.maxRecoverySteps ?? 3;
    const stateNames = new Map(trace.discoveredStates.map((s) => [s.stateId, s.name]));
    let recoveries = 0;
    let currentStep = 0;
    let currentStateId: string | undefined;
    const executed: string[] = [];
    const executedActions: AgentAction[] = [];

    const monitor = attachPageMonitor(page);
    let detachPolicy: (() => Promise<void>) | undefined;
    try {
      const url = session.prepareUrl ? await session.prepareUrl(startUrl) : startUrl;
      const policy = new ActionPolicy(url, opts.exploreConfig);
      detachPolicy = await policy.attach(page);
      await page.goto(url, { waitUntil: opts.scanConfig.waitUntil, timeout: 60000 });
      await stabilizePage(page, opts.scanConfig.extraWaitMs);

      const stateMatches = async (stateId: string) => {
        const expected = trace.discoveredStates.find((state) => state.stateId === stateId);
        if (!expected) return false;
        const actual = computeStateFingerprint(await snapshotPage(page), page.url());
        const expectedUrl = rebaseTraceUrl(expected.url, trace, url);
        return actual.fingerprint === expected.fingerprint || actual.name === expected.name && new URL(page.url()).pathname === new URL(expectedUrl).pathname;
      };

      const captureState = async (stateId: string, stepIndex: number) => {
        budget.assertActive();
        if (seen.has(stateId)) {
          const existing = stateResults.find((state) => state.stateId === stateId)!;
          await appendRuntimeErrors(existing, monitor.drain(), { stateId, trace: [...executed], actions: [...executedActions] });
          return;
        }
        budget.claimState(stateId);
        seen.add(stateId);
        const snap = await snapshotPage(page);
        const { fingerprint } = computeStateFingerprint(snap, page.url());
        const renderId = renderIdForTarget(target, stateId);
        const capture = await captureCurrentState({
          session, renderId, renderDir: path.join(opts.outputDir, "renders", renderId),
          url: page.url(), fullPage: opts.scanConfig.fullPage, monitor: monitor.drain(), snapshot: snap
        });
        const analyzed = await analyzeCapture(capture, opts.scanConfig, vision, {
          stateId, trace: [...executed], actions: [...executedActions]
        }, budget);
        stateResults.push({ ...analyzed, stateId, stateName: stateNames.get(stateId),
          trace: [...executed], targetId: target.id, fingerprint });
        opts.onProgress?.({ phase: "replay", deviceId: target.id, step: stepIndex, stateId,
          stateName: stateNames.get(stateId), screenshotPath: capture.screenshotPath, agentCalls: agent.llmCalls, tokensUsed: agent.tokensUsed });
      };

      for (let i = 0; i < trace.steps.length; i++) {
        budget.assertActive();
        currentStep = i;
        const step: ExplorationStep = trace.steps[i];
        currentStateId = step.stateBefore;
        if (!(await stateMatches(step.stateBefore))) return { traceId: trace.traceId, targetId: target.id, success: false, stateResults,
          divergedAtStep: i, recoveries, agentCalls: agent.llmCalls, tokensUsed: agent.tokensUsed, message: `Recorded state '${stateNames.get(step.stateBefore)}' was not reached` };
        await captureState(step.stateBefore, i);
        const snap = await snapshotPage(page);

        if (step.action.type === "done") break;
        if (step.failed) continue; // the pilot couldn't execute it either

        const action = rebaseTraceAction(step.action, trace, startUrl);
        const reached = async () => step.stateBefore === step.stateAfter || await stateMatches(step.stateAfter);
        budget.consumeAction();
        let result = await executeAction(session, action, snap, policy);
        if (result.success && !(await reached())) result = { success: false, details: "Action did not reach the recorded state" };
        for (let r = 0; !result.success && !result.blocked && r < maxRecovery; r++) {
          budget.assertActive();
          const snap2 = await snapshotPage(page);
          const fp2 = computeStateFingerprint(snap2, page.url()).fingerprint;
          const shot = await session.control.captureScreenshot();
          const observationPath = path.join(opts.outputDir, "explore", "observations", renderIdForTarget(target), `recovery-${i}-${r}.png`);
          await fs.mkdir(path.dirname(observationPath), { recursive: true });
          await fs.writeFile(observationPath, shot);
          const goal = `${describeAction(step.action)} leading to state "${stateNames.get(step.stateAfter) ?? step.stateAfter}"`;
          const recovery = await agent.decideNextAction(snap2, shot.toString("base64"), page.url(), fp2, {
            goal,
            history: executed,
            isTV: target.isTV,
            recoveryId: `${trace.traceId}:${target.id}:${i}`
          });
          opts.onProgress?.({
            phase: "recover",
            deviceId: target.id,
            step: i,
            action: recovery,
            screenshotPath: observationPath,
            agentCalls: agent.llmCalls,
            tokensUsed: agent.tokensUsed,
            message: goal
          });
          if (recovery.type === "done") break;
          budget.consumeAction();
          const rr = await executeAction(session, recovery, snap2, policy);
          if (rr.success) {
            executed.push(`[recovery] ${describeAction(recovery)}`);
            executedActions.push(recovery);
          }
          if (rr.blocked) { result = rr; break; }
          budget.consumeAction();
          result = await executeAction(session, action, await snapshotPage(page), policy);
          if (result.success && !(await reached())) result = { success: false, details: "Action did not reach the recorded state" };
          if (result.success) recoveries++;
        }

        if (!result.success) {
          return { traceId: trace.traceId, targetId: target.id, success: false, stateResults, divergedAtStep: i, recoveries, agentCalls: agent.llmCalls, tokensUsed: agent.tokensUsed, message: result.details };
        }
        executed.push(describeAction(action));
        executedActions.push(action);
        currentStateId = step.stateAfter;
      }
      // A budget-limited pilot has no trailing `done` step. Its final state still needs a capture.
      const finalState = trace.steps.at(-1)?.stateAfter ?? trace.discoveredStates[0]?.stateId;
      if (finalState && !(await stateMatches(finalState))) return { traceId: trace.traceId, targetId: target.id, success: false, stateResults,
        divergedAtStep: trace.steps.length, recoveries, agentCalls: agent.llmCalls, tokensUsed: agent.tokensUsed, message: "Final recorded state was not reached" };
      if (finalState) await captureState(finalState, trace.steps.length);
      return { traceId: trace.traceId, targetId: target.id, success: true, stateResults, recoveries, agentCalls: agent.llmCalls, tokensUsed: agent.tokensUsed };
    } catch (error) {
      return { traceId: trace.traceId, targetId: target.id, success: false, stateResults, divergedAtStep: currentStep,
        recoveries, agentCalls: agent.llmCalls, tokensUsed: agent.tokensUsed, message: (error as Error).message.split("\n")[0] };
    } finally {
      try {
        const last = stateResults.find((state) => state.stateId === currentStateId) ?? stateResults.at(-1);
        if (last) await appendRuntimeErrors(last, monitor.drain(), { stateId: last.stateId, trace: [...executed], actions: [...executedActions] });
      } finally { monitor.detach(); detachAbort(); await detachPolicy?.(); if (!opts.budget) budget.dispose(); }
    }
  }
}

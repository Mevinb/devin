import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractDOMSnapshotInBrowser } from "../capture/dom-snapshot.js";
import type { CaptureResult, DOMSnapshot } from "../capture/types.js";
import { runHeuristics } from "../heuristics/index.js";
import type { Finding } from "../heuristics/types.js";
import { globalDeviceRegistry, type DeviceRegistry } from "../runtime/registry.js";
import type { DeviceSession, DeviceTarget } from "../runtime/types.js";
import { ExplorationAgent } from "./agent.js";
import { computeStateFingerprint } from "./fingerprint.js";
import { ReplayEngine, type ReplayStateResult } from "./replay.js";
import { executeAction } from "./tools.js";
import type {
  DiscoveredState,
  ExplorationStep,
  ExplorationTrace,
  ExploreConfig
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
}

export class PilotThenReplayScheduler {
  constructor(
    private readonly registry: DeviceRegistry = globalDeviceRegistry,
    private readonly replayEngine: ReplayEngine = new ReplayEngine()
  ) {}

  async run(
    targetUrl: string,
    targets: DeviceTarget[],
    config: Partial<ExploreConfig> = {},
    outputDir = "./pixelsentinel-output"
  ): Promise<MultiDeviceExploreResult> {
    if (targets.length === 0) {
      throw new Error("At least one device target is required for exploration.");
    }

    const pilotTarget =
      targets.find((t) => t.id === config.pilotDevice) || targets[0];
    const secondaryTargets = targets.filter((t) => t.id !== pilotTarget.id);

    const exploreBaseDir = path.join(outputDir, "explore");
    await fs.mkdir(exploreBaseDir, { recursive: true });

    // Step 1: Pilot Exploration
    const pilotRuntime = this.registry.getRuntime(pilotTarget.runtime);
    const pilotSession: DeviceSession = await pilotRuntime.launch(pilotTarget);

    const discoveredStates: DiscoveredState[] = [];
    const steps: ExplorationStep[] = [];
    const stateFingerprintMap = new Map<string, string>(); // fingerprint -> stateId
    const agent = new ExplorationAgent(config);

    const startTime = new Date().toISOString();
    const traceId = `trace-${crypto.randomUUID().slice(0, 8)}`;

    try {
      await pilotSession.page.goto(targetUrl, {
        waitUntil: "networkidle",
        timeout: 30000
      });
      await pilotSession.page.waitForTimeout(1000);

      const maxSteps = config.maxSteps || 20;

      for (let i = 0; i < maxSteps; i++) {
        const stepDir = path.join(exploreBaseDir, "pilot", `step-${i}`);
        await fs.mkdir(stepDir, { recursive: true });

        const domSnapshot = (await pilotSession.page.evaluate(
          extractDOMSnapshotInBrowser
        )) as DOMSnapshot;

        const screenshotBuffer = await pilotSession.control.captureScreenshot();
        const screenshotPath = path.join(stepDir, "screenshot.png");
        const domPath = path.join(stepDir, "dom.json");

        await fs.writeFile(screenshotPath, screenshotBuffer);
        await fs.writeFile(domPath, JSON.stringify(domSnapshot, null, 2), "utf8");

        const currentUrl = pilotSession.page.url();
        const { fingerprint, name: stateTitle } = computeStateFingerprint(
          domSnapshot,
          currentUrl
        );

        let stateId = stateFingerprintMap.get(fingerprint);
        if (!stateId) {
          stateId = `state-${discoveredStates.length + 1}`;
          stateFingerprintMap.set(fingerprint, stateId);

          const renderConfig = {
            renderId: `${pilotTarget.id}-${stateId}`,
            name: pilotTarget.name,
            width: pilotTarget.viewport.width,
            height: pilotTarget.viewport.height,
            deviceScaleFactor: pilotTarget.deviceScaleFactor,
            isMobile: pilotTarget.isMobile,
            hasTouch: pilotTarget.hasTouch,
            orientation: pilotTarget.orientation || "landscape",
            deviceTarget: pilotTarget
          };

          const captureResult: CaptureResult = {
            renderConfig,
            screenshotBuffer,
            screenshotPath,
            domSnapshot,
            domPath,
            metadata: {
              renderId: renderConfig.renderId,
              viewport: renderConfig,
              url: currentUrl,
              timestamp: new Date().toISOString(),
              consoleErrors: [],
              failedRequests: [],
              hasHorizontalScroll:
                domSnapshot.document.scrollWidth > domSnapshot.document.innerWidth + 2,
              screenshotPath,
              domPath,
              dimensions: {
                viewportWidth: pilotTarget.viewport.width,
                viewportHeight: pilotTarget.viewport.height,
                pageWidth: domSnapshot.document.scrollWidth,
                pageHeight: domSnapshot.document.scrollHeight
              }
            },
            metaPath: path.join(stepDir, "meta.json")
          };

          const findings = runHeuristics(captureResult).map((f) => ({
            ...f,
            stateId,
            targetId: pilotTarget.id,
            device: pilotTarget.name,
            fidelity: pilotTarget.fidelity,
            trace: steps.map((s) => JSON.stringify(s.action))
          }));

          discoveredStates.push({
            stateId,
            name: stateTitle,
            fingerprint,
            url: currentUrl,
            stepIndex: i,
            captureResult,
            findings
          });
        }

        // Ask agent for next action
        const action = await agent.decideNextAction(
          domSnapshot,
          screenshotBuffer.toString("base64"),
          currentUrl,
          fingerprint
        );

        steps.push({
          stepIndex: i,
          action,
          stateBefore: stateId,
          stateAfter: stateId, // updated below
          timestamp: new Date().toISOString(),
          screenshotPath
        });

        if (action.type === "done") {
          break;
        }

        // Execute action
        await executeAction(pilotSession, action, domSnapshot);
      }
    } finally {
      await pilotSession.close();
    }

    const endTime = new Date().toISOString();
    const trace: ExplorationTrace = {
      traceId,
      pilotTarget,
      steps,
      discoveredStates,
      startTime,
      endTime
    };

    // Save trace artifact
    await fs.writeFile(
      path.join(exploreBaseDir, "trace.json"),
      JSON.stringify(trace, null, 2),
      "utf8"
    );

    // Build the Device x State matrix
    const matrix: DeviceStateMatrixEntry[] = [];
    const allFindings: Finding[] = [];

    // Add pilot findings to matrix
    for (const state of discoveredStates) {
      matrix.push({
        deviceId: pilotTarget.id,
        deviceName: pilotTarget.name,
        stateId: state.stateId,
        stateName: state.name,
        fidelity: pilotTarget.fidelity,
        captureResult: state.captureResult,
        findings: state.findings
      });
      allFindings.push(...state.findings);
    }

    // Step 2: Replay deterministic trace on secondary devices
    for (const target of secondaryTargets) {
      const runtime = this.registry.getRuntime(target.runtime);
      const session = await runtime.launch(target);

      try {
        const replayResult = await this.replayEngine.replayTraceOnSession(
          trace,
          session,
          exploreBaseDir
        );

        // Group by stateId
        const stateGroups = new Map<string, ReplayStateResult>();
        for (const sr of replayResult.stateResults) {
          if (!stateGroups.has(sr.stateId)) {
            stateGroups.set(sr.stateId, sr);
          }
        }

        for (const state of discoveredStates) {
          const matched = stateGroups.get(state.stateId);
          if (matched) {
            matrix.push({
              deviceId: target.id,
              deviceName: target.name,
              stateId: state.stateId,
              stateName: state.name,
              fidelity: target.fidelity,
              captureResult: matched.captureResult,
              findings: matched.findings
            });
            allFindings.push(...matched.findings);
          }
        }
      } finally {
        await session.close();
      }
    }

    return {
      trace,
      states: discoveredStates,
      matrix,
      allFindings
    };
  }
}

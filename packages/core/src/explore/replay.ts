import fs from "node:fs/promises";
import path from "node:path";
import { extractDOMSnapshotInBrowser } from "../capture/dom-snapshot.js";
import type { CaptureResult, DOMSnapshot } from "../capture/types.js";
import { runHeuristics } from "../heuristics/index.js";
import type { Finding } from "../heuristics/types.js";
import type { DeviceSession } from "../runtime/types.js";
import { computeStateFingerprint } from "./fingerprint.js";
import { executeAction } from "./tools.js";
import type { ExplorationTrace } from "./types.js";

export interface ReplayStateResult {
  stateId: string;
  targetId: string;
  fingerprint: string;
  captureResult: CaptureResult;
  findings: Finding[];
}

export interface ReplayResult {
  traceId: string;
  targetId: string;
  success: boolean;
  stateResults: ReplayStateResult[];
  divergedAtStep?: number;
}

export class ReplayEngine {
  async replayTraceOnSession(
    trace: ExplorationTrace,
    session: DeviceSession,
    outputBaseDir: string
  ): Promise<ReplayResult> {
    const { page, target } = session;
    const stateResults: ReplayStateResult[] = [];
    const targetDir = path.join(outputBaseDir, "replays", target.id);
    await fs.mkdir(targetDir, { recursive: true });

    // Initial navigation
    const initialUrl = trace.discoveredStates[0]?.url || "http://localhost:3000";
    await page.goto(initialUrl, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1000);

    for (let i = 0; i < trace.steps.length; i++) {
      const step = trace.steps[i];
      const stepDir = path.join(targetDir, `step-${i}`);
      await fs.mkdir(stepDir, { recursive: true });

      // Capture before state
      const domSnapshot = (await page.evaluate(extractDOMSnapshotInBrowser)) as DOMSnapshot;
      const screenshotBuffer = await session.control.captureScreenshot();
      const screenshotPath = path.join(stepDir, "screenshot.png");
      const domPath = path.join(stepDir, "dom.json");

      await fs.writeFile(screenshotPath, screenshotBuffer);
      await fs.writeFile(domPath, JSON.stringify(domSnapshot, null, 2), "utf8");

      const { fingerprint } = computeStateFingerprint(domSnapshot, page.url());
      const renderConfig = {
        renderId: `${target.id}-step-${i}`,
        name: target.name,
        width: target.viewport.width,
        height: target.viewport.height,
        deviceScaleFactor: target.deviceScaleFactor,
        isMobile: target.isMobile,
        hasTouch: target.hasTouch,
        orientation: target.orientation || "landscape",
        deviceTarget: target
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
          url: page.url(),
          timestamp: new Date().toISOString(),
          consoleErrors: [],
          failedRequests: [],
          hasHorizontalScroll:
            domSnapshot.document.scrollWidth > domSnapshot.document.innerWidth + 2,
          screenshotPath,
          domPath,
          dimensions: {
            viewportWidth: target.viewport.width,
            viewportHeight: target.viewport.height,
            pageWidth: domSnapshot.document.scrollWidth,
            pageHeight: domSnapshot.document.scrollHeight
          }
        },
        metaPath: path.join(stepDir, "meta.json")
      };

      const findings = runHeuristics(captureResult).map((f) => ({
        ...f,
        stateId: step.stateBefore,
        targetId: target.id,
        device: target.name,
        fidelity: target.fidelity,
        trace: trace.steps.slice(0, i).map((s) => JSON.stringify(s.action))
      }));

      stateResults.push({
        stateId: step.stateBefore,
        targetId: target.id,
        fingerprint,
        captureResult,
        findings
      });

      if (step.action.type === "done") {
        break;
      }

      // Execute action
      const execResult = await executeAction(session, step.action, domSnapshot);
      if (!execResult.success) {
        return {
          traceId: trace.traceId,
          targetId: target.id,
          success: false,
          stateResults,
          divergedAtStep: i
        };
      }
    }

    return {
      traceId: trace.traceId,
      targetId: target.id,
      success: true,
      stateResults
    };
  }
}

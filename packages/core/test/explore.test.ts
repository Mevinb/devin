import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockExplorationAgent } from "../src/explore/mock-agent.js";
import { computeStateFingerprint } from "../src/explore/fingerprint.js";
import { PilotThenReplayScheduler } from "../src/explore/scheduler.js";
import { BUILTIN_DEVICES } from "../src/runtime/registry.js";
import type { DOMSnapshot } from "../src/capture/types.js";

describe("Autonomous Multi-State Exploration Engine", () => {
  it("computes deterministic state fingerprints and detects modal titles", () => {
    const mockSnapshot: DOMSnapshot = {
      document: {
        scrollWidth: 1200,
        scrollHeight: 800,
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 1
      },
      elements: [
        {
          id: "el-1",
          selector: "h1.title",
          tagName: "h1",
          text: "Checkout Portal",
          rect: { x: 20, y: 20, width: 200, height: 40, top: 20, left: 20, right: 220, bottom: 60 },
          styles: {
            zIndex: 0,
            overflow: "visible",
            overflowX: "visible",
            overflowY: "visible",
            position: "static",
            display: "block",
            visibility: "visible",
            opacity: 1,
            fontSize: "24px",
            lineHeight: "32px",
            color: "#fff",
            backgroundColor: "transparent"
          },
          metrics: { scrollWidth: 200, scrollHeight: 40, clientWidth: 200, clientHeight: 40 },
          isInteractive: false,
          isClipped: false,
          parentId: null
        }
      ]
    };

    const { fingerprint, name } = computeStateFingerprint(mockSnapshot, "http://localhost:3000/checkout");
    expect(fingerprint).toBeDefined();
    expect(fingerprint.length).toBe(16);
    expect(name).toBe("Checkout Portal");
  });

  it("mock exploration agent steps through interactive elements until done", async () => {
    const agent = new MockExplorationAgent({ maxSteps: 3 });
    const mockSnapshot: DOMSnapshot = {
      document: { scrollWidth: 1000, scrollHeight: 800, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 },
      elements: [
        {
          id: "btn-1",
          selector: "button#submit",
          tagName: "button",
          text: "Submit",
          rect: { x: 50, y: 50, width: 80, height: 40, top: 50, left: 50, right: 130, bottom: 90 },
          styles: {
            zIndex: 0,
            overflow: "visible",
            overflowX: "visible",
            overflowY: "visible",
            position: "static",
            display: "block",
            visibility: "visible",
            opacity: 1,
            fontSize: "14px",
            lineHeight: "20px",
            color: "#fff",
            backgroundColor: "#000"
          },
          metrics: { scrollWidth: 80, scrollHeight: 40, clientWidth: 80, clientHeight: 40 },
          isInteractive: true,
          isClipped: false,
          parentId: null
        }
      ]
    };

    const action1 = await agent.decideNextAction(mockSnapshot, "http://localhost/", "state-1");
    expect(action1.type).toBe("tap");

    // Once all elements are visited
    const action2 = await agent.decideNextAction(mockSnapshot, "http://localhost/", "state-1");
    expect(action2.type).toBe("done");
  });

  it("runs pilot-then-replay scheduler on flows fixture across multiple devices", async () => {
    const fixturePath = `file://${path.resolve(__dirname, "../../../fixtures/flows/index.html")}`;
    const scheduler = new PilotThenReplayScheduler();

    const targets = [
      BUILTIN_DEVICES["chromium:desktop-1080p"],
      BUILTIN_DEVICES["android:pixel-8"]
    ];

    const result = await scheduler.run(
      fixturePath,
      targets,
      { maxSteps: 4, maxStates: 3 },
      "./pixelsentinel-output/test-explore"
    );

    expect(result.states.length).toBeGreaterThan(0);
    expect(result.matrix.length).toBeGreaterThan(0);
    expect(result.trace.steps.length).toBeGreaterThan(0);

    // Verify findings include defects from fixture (e.g. horizontal overflow or safe area)
    expect(result.allFindings.length).toBeGreaterThan(0);
  }, 45000);
});

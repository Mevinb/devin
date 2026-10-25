import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { MockExplorationAgent } from "../src/explore/mock-agent.js";
import { computeStateFingerprint } from "../src/explore/fingerprint.js";
import { PilotThenReplayScheduler } from "../src/explore/scheduler.js";
import { BUILTIN_DEVICES, globalDeviceRegistry } from "../src/runtime/registry.js";
import { startStaticServer } from "../src/target/static-server.js";
import type { DOMSnapshot } from "../src/capture/types.js";

describe("Autonomous Multi-State Exploration Engine", () => {
  it("retains exceptions from actions that do not change the structural state", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-explore-error-"));
    await fs.writeFile(path.join(temp, "index.html"), `<h1>Home</h1><button id="validate" onclick="throw new Error('unchanged-dom-error')">Validate form</button>`);
    const server = await startStaticServer(temp);
    try {
      const result = await new PilotThenReplayScheduler().run(server.url, [BUILTIN_DEVICES["chromium:desktop-1080p"]],
        { maxSteps: 2, maxStates: 3, useMockAgent: true }, path.join(temp, "out"));
      expect(result.states).toHaveLength(1);
      const error = result.allFindings.find((finding) => finding.type === "runtime-error" && finding.description.includes("unchanged-dom-error"));
      expect(error).toBeDefined(); expect(error!.trace?.some((step) => step.includes("#validate"))).toBe(true);
      const meta = JSON.parse(await fs.readFile(result.states[0].captureResult.metaPath, "utf8"));
      expect(meta.pageErrors.some((message: string) => message.includes("unchanged-dom-error"))).toBe(true);
    } finally { await server.cleanup(); await globalDeviceRegistry.shutdownAll(); await fs.rm(temp, { recursive: true, force: true }); }
  });

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
    process.env.PIXELSENTINEL_DEVICES = "approximate";
    const server = await startStaticServer(path.resolve(__dirname, "../../../fixtures/flows"));
    const scheduler = new PilotThenReplayScheduler();

    const targets = [
      BUILTIN_DEVICES["chromium:desktop-1080p"],
      BUILTIN_DEVICES["chromium:desktop-1440p"],
      BUILTIN_DEVICES["android:pixel-8"],
      BUILTIN_DEVICES["webkit:iphone-15-pro"]
    ];

    try {
      const result = await scheduler.run(
        server.url,
        targets,
        { maxSteps: 30, maxStates: 6, useMockAgent: true },
        "./pixelsentinel-output/test-explore"
      );

      expect(result.states.map((state) => state.name)).toEqual(expect.arrayContaining([
        "Welcome to NovaStore", "Product Catalog", "Order Checkout", "Modal: Special VIP Reward", "Contact details", "Check your details"
      ]));
      expect(result.states).toHaveLength(6);
      expect(result.trace.steps.length).toBeGreaterThan(0);
      // Every step carries a stable selector, so replay works across devices
      for (const step of result.trace.steps.filter((s) => s.action.type === "tap")) {
        expect((step.action as { selector?: string }).selector).toBeTruthy();
      }
      // Replays must not diverge (previously the iPhone tapped an off-screen button and stopped)
      for (const replay of result.replays) {
        expect(replay.success, `${replay.targetId} diverged at ${replay.divergedAtStep}: ${JSON.stringify(result.errors)}`).toBe(true);
      }
      const devicesInMatrix = new Set(result.matrix.map((m) => m.deviceId));
      expect(devicesInMatrix.size).toBe(4);
      expect(result.errors).toEqual([]);
      expect(result.replays.find((replay) => replay.targetId === "chromium:desktop-1440p")).toMatchObject({ success: true, recoveries: 0, agentCalls: 0 });
      expect(result.replays.find((replay) => replay.targetId === "android:pixel-8")!.recoveries).toBeGreaterThanOrEqual(1);
      for (const target of targets) expect(result.matrix.filter((item) => item.deviceId === target.id).map((item) => item.stateId))
        .toEqual(expect.arrayContaining(result.states.map((state) => state.stateId)));
      expect(result.allFindings.length).toBeGreaterThan(0);
    } finally { await server.cleanup(); await globalDeviceRegistry.shutdownAll(); }
  }, 150000);

  it("recovers replay on mobile via the agent when targets hide behind a hamburger menu", async () => {
    process.env.PIXELSENTINEL_DEVICES = "approximate";
    const server = await startStaticServer(path.resolve(__dirname, "../../../fixtures/flows-app"));
    try {
      const result = await new PilotThenReplayScheduler().run(
        server.url,
        [BUILTIN_DEVICES["chromium:desktop-1080p"], BUILTIN_DEVICES["android:pixel-8"]],
        { maxSteps: 30, maxStates: 8, useMockAgent: true, allowDestructive: true }, // owned fixture's synthetic Send action
        "./pixelsentinel-output/test-explore-menu"
      );
      const names = result.states.map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(["Pricing", "Contact us"]));

      const mobile = result.replays.find((r) => r.targetId === "android:pixel-8")!;
      expect(mobile.success).toBe(true);
      expect(mobile.recoveries).toBeGreaterThanOrEqual(1);

      // Seeded front-end exception on contact submit is reported as a runtime error
      const runtimeErrors = result.allFindings.filter((f) => f.type === "runtime-error");
      expect(runtimeErrors.some((f) => /reading 'track'.*app\.js:\d+/.test(f.description))).toBe(true);
      // Seeded 480px price card overflows the phone
      const mobileFindings = result.matrix.filter((m) => m.deviceId === "android:pixel-8").flatMap((m) => m.findings);
      expect(mobileFindings.some((f) => f.type === "horizontal-overflow")).toBe(true);
    } finally {
      await server.cleanup();
      await globalDeviceRegistry.shutdownAll();
    }
  }, 120000);
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { scan } from "../src/scanner.js";
import { MockVisionProvider } from "../src/vision/mock-provider.js";
import { BUILTIN_DEVICES } from "../src/runtime/registry.js";

describe("Real-Device Heuristics Detection", () => {
  const fixturesDir = path.resolve(__dirname, "../../../fixtures/device");
  const mockVision = new MockVisionProvider([]);

  it("detects safe-area / notch intrusion on notch test page", async () => {
    const fixturePath = path.join(fixturesDir, "safe-area.html");
    const pixel8 = BUILTIN_DEVICES["android:pixel-8"];

    const report = await scan(
      {
        target: fixturePath,
        viewports: [
          {
            name: pixel8.name,
            width: pixel8.viewport.width,
            height: pixel8.viewport.height,
            deviceScaleFactor: pixel8.deviceScaleFactor,
            isMobile: true,
            hasTouch: true,
            orientation: "portrait",
            deviceDescriptor: pixel8.id
          }
        ],
        output: { dir: "./pixelsentinel-output/test-safe-area", clean: true }
      },
      { visionProvider: mockVision }
    );

    const hasNotchIntrusion = report.matrix[0].findings.some(
      (f) => f.type === "safe-area-intrusion"
    );
    expect(hasNotchIntrusion).toBe(true);
  }, 30000);

  it("detects soft keyboard obstruction on bottom chat input", async () => {
    const fixturePath = path.join(fixturesDir, "keyboard.html");
    const iphone = BUILTIN_DEVICES["webkit:iphone-15-pro"];

    const report = await scan(
      {
        target: fixturePath,
        viewports: [
          {
            name: iphone.name,
            width: iphone.viewport.width,
            height: iphone.viewport.height,
            deviceScaleFactor: iphone.deviceScaleFactor,
            isMobile: true,
            hasTouch: true,
            orientation: "portrait",
            deviceDescriptor: iphone.id
          }
        ],
        output: { dir: "./pixelsentinel-output/test-keyboard", clean: true }
      },
      { visionProvider: mockVision }
    );

    const hasKeyboardObstruction = report.matrix[0].findings.some(
      (f) => f.type === "keyboard-obstruction"
    );
    expect(hasKeyboardObstruction).toBe(true);
  }, 30000);

  it("detects foldable physical hinge seam collision", async () => {
    const fixturePath = path.join(fixturesDir, "hinge.html");
    const fold = BUILTIN_DEVICES["android:pixel-fold"];

    const report = await scan(
      {
        target: fixturePath,
        viewports: [
          {
            name: fold.name,
            width: fold.viewport.width,
            height: fold.viewport.height,
            deviceScaleFactor: fold.deviceScaleFactor,
            isMobile: true,
            hasTouch: true,
            orientation: "landscape",
            deviceDescriptor: fold.id
          }
        ],
        output: { dir: "./pixelsentinel-output/test-hinge", clean: true }
      },
      { visionProvider: mockVision }
    );

    const hasHingeOverlap = report.matrix[0].findings.some(
      (f) => f.type === "hinge-overlap"
    );
    expect(hasHingeOverlap).toBe(true);
  }, 30000);

  it("detects TV 5% overscan safety boundary violations", async () => {
    const fixturePath = path.join(fixturesDir, "overscan.html");
    const tv = BUILTIN_DEVICES["android:tv-1080p"];

    const report = await scan(
      {
        target: fixturePath,
        viewports: [
          {
            name: tv.name,
            width: tv.viewport.width,
            height: tv.viewport.height,
            deviceScaleFactor: tv.deviceScaleFactor,
            isMobile: false,
            hasTouch: false,
            orientation: "landscape",
            deviceDescriptor: tv.id
          }
        ],
        output: { dir: "./pixelsentinel-output/test-overscan", clean: true }
      },
      { visionProvider: mockVision }
    );

    const hasOverscan = report.matrix[0].findings.some(
      (f) => f.type === "tv-overscan-violation"
    );
    expect(hasOverscan).toBe(true);
  }, 30000);

  it("detects TV missing D-pad focus indicators", async () => {
    const fixturePath = path.join(fixturesDir, "focus-ring.html");
    const tv = BUILTIN_DEVICES["android:tv-1080p"];

    const report = await scan(
      {
        target: fixturePath,
        viewports: [
          {
            name: tv.name,
            width: tv.viewport.width,
            height: tv.viewport.height,
            deviceScaleFactor: tv.deviceScaleFactor,
            isMobile: false,
            hasTouch: false,
            orientation: "landscape",
            deviceDescriptor: tv.id
          }
        ],
        output: { dir: "./pixelsentinel-output/test-focus-ring", clean: true }
      },
      { visionProvider: mockVision }
    );

    const hasFocusRingIssue = report.matrix[0].findings.some(
      (f) => f.type === "tv-missing-focus-ring"
    );
    expect(hasFocusRingIssue).toBe(true);
  }, 30000);
});

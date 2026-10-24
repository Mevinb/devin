import path from "node:path";
import { describe, expect, it } from "vitest";
import { scan } from "../src/scanner.js";
import { MockVisionProvider } from "../src/vision/mock-provider.js";

describe("PixelSentinel End-to-End Fixture Scans", () => {
  const fixturesDir = path.resolve(__dirname, "../../../fixtures");

  it("detects no defects on the clean baseline fixture", async () => {
    const cleanPath = path.join(fixturesDir, "clean");
    const mockVision = new MockVisionProvider([]);

    const report = await scan(
      {
        target: cleanPath,
        viewports: [
          {
            name: "desktop-test",
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
            orientation: "landscape"
          }
        ],
        output: {
          dir: "./pixelsentinel-output/test-clean",
          clean: true,
          html: true,
          json: true
        }
      },
      {
        visionProvider: mockVision
      }
    );

    expect(report.summary.totalFindings).toBe(0);
    expect(report.summary.passedViewports).toBe(1);
    expect(report.matrix[0].status).toBe("pass");
  }, 30000);

  it("detects horizontal overflow defect on overflow-horizontal fixture", async () => {
    const overflowPath = path.join(fixturesDir, "overflow-horizontal");
    const mockVision = new MockVisionProvider([]);

    const report = await scan(
      {
        target: overflowPath,
        viewports: [
          {
            name: "mobile-test",
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            orientation: "portrait"
          }
        ],
        output: {
          dir: "./pixelsentinel-output/test-overflow",
          clean: true
        }
      },
      {
        visionProvider: mockVision
      }
    );

    expect(report.summary.criticalFindings).toBeGreaterThan(0);
    const hasHorizontalOverflow = report.matrix[0].findings.some(
      (f) => f.type === "horizontal-overflow"
    );
    expect(hasHorizontalOverflow).toBe(true);
  }, 30000);

  it("detects element overlap defect on overlap fixture", async () => {
    const overlapPath = path.join(fixturesDir, "overlap");
    const mockVision = new MockVisionProvider([]);

    const report = await scan(
      {
        target: overlapPath,
        viewports: [
          {
            name: "desktop-overlap",
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
            orientation: "landscape"
          }
        ],
        output: {
          dir: "./pixelsentinel-output/test-overlap",
          clean: true
        }
      },
      {
        visionProvider: mockVision
      }
    );

    const hasOverlap = report.matrix[0].findings.some(
      (f) => f.type === "element-overlap"
    );
    expect(hasOverlap).toBe(true);
  }, 30000);

  it("detects text clipping defect on clipped fixture", async () => {
    const clippedPath = path.join(fixturesDir, "clipped");
    const mockVision = new MockVisionProvider([]);

    const report = await scan(
      {
        target: clippedPath,
        viewports: [
          {
            name: "desktop-clipped",
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
            orientation: "landscape"
          }
        ],
        output: {
          dir: "./pixelsentinel-output/test-clipped",
          clean: true
        }
      },
      {
        visionProvider: mockVision
      }
    );

    const hasClipping = report.matrix[0].findings.some(
      (f) => f.type === "text-clipping"
    );
    expect(hasClipping).toBe(true);
  }, 30000);
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlaywrightRuntime } from "../src/runtime/playwright.js";
import { BUILTIN_DEVICES } from "../src/runtime/registry.js";
import { captureCurrentState } from "../src/capture/session.js";
import { ScanConfigSchema } from "../src/config/schema.js";
import { analyzeCapture, scan } from "../src/scanner.js";
import type { VisionProvider } from "../src/vision/types.js";

let temp: string;
const runtime = new PlaywrightRuntime();
const markup = '<style>body{margin:0;min-height:2000px}#marker{position:absolute;left:100px;top:1200px;width:80px;height:30px;background:#ccc}</style><div id="marker">Marker</div>';
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-capture-geometry-")); });
afterEach(async () => { vi.restoreAllMocks(); await runtime.shutdown(); await fs.rm(temp, { recursive: true, force: true }); });

it.each([false, true])("correlates and annotates a scrolled DPR2 capture with fullPage=%s", async (fullPage) => {
  const session = await runtime.launch({ ...BUILTIN_DEVICES["chromium:desktop-1080p"], viewport: { width: 400, height: 300 }, deviceScaleFactor: 2 });
  try {
    await session.page.setContent(markup); await session.page.evaluate(() => window.scrollTo(0, 1000));
    const capture = await captureCurrentState({ session, url: "about:blank", renderId: "geometry", renderDir: temp, fullPage });
    const geometry = capture.metadata.screenshotGeometry!;
    expect(geometry).toEqual({ cssWidth: 400, cssHeight: fullPage ? 2000 : 300, pixelWidth: 800, pixelHeight: fullPage ? 4000 : 600,
      originX: 0, originY: fullPage ? 0 : 1000, fullPage });
    const provider: VisionProvider = { name: "offline-geometry", analyze: async (_image, context) => {
      expect(context.imageWidth).toBe(400); expect(context.imageHeight).toBe(geometry.cssHeight); expect(context.originY).toBe(geometry.originY);
      return { findings: [{ type: "unreadable-text", severity: "critical", confidence: 0.9, description: "Synthetic geometry finding",
        bbox: { xmin: 0.25, xmax: 0.45, ymin: (1200 - geometry.originY) / geometry.cssHeight, ymax: (1230 - geometry.originY) / geometry.cssHeight } }] };
    } };
    const analyzed = await analyzeCapture(capture, ScanConfigSchema.parse({ target: "https://fixture.invalid" }), provider);
    const finding = analyzed.findings.find((item) => item.sources.includes("vision"))!;
    expect(finding.bbox).toMatchObject({ x: 100, y: 1200, width: 80, height: 30 });
    expect(finding.elements[0].selector).toBe("#marker");
    const { data } = await sharp(analyzed.annotatedPath).extract({ left: 210, top: (1200 - geometry.originY) * 2 + 50, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(data[1] + 10);
    expect(JSON.parse(await fs.readFile(capture.metaPath, "utf8")).screenshotGeometry).toEqual(geometry);
  } finally { await session.close(); }
});

it("records viewport geometry when a full-page screenshot falls back", async () => {
  const session = await runtime.launch({ ...BUILTIN_DEVICES["chromium:desktop-1080p"], viewport: { width: 400, height: 300 } });
  try {
    await session.page.setContent(markup); await session.page.evaluate(() => window.scrollTo(0, 1000));
    vi.spyOn(session.page, "screenshot").mockRejectedValueOnce(new Error("Full-page size exceeds browser limit"));
    const capture = await captureCurrentState({ session, url: "about:blank", renderId: "fallback", renderDir: temp, fullPage: true });
    expect(capture.metadata.screenshotGeometry).toMatchObject({ fullPage: false, cssHeight: 300, originY: 1000 });
  } finally { await session.close(); }
});

it("uses the shared page-error capture pipeline for Phase 1 viewport scans", async () => {
  const project = path.join(temp, "project"); await fs.mkdir(project);
  await fs.writeFile(path.join(project, "index.html"), '<h1>Phase 1</h1><script>throw new Error("viewport-pipeline-error")</script>');
  const report = await scan({ target: project, viewports: [{ name: "legacy", width: 400, height: 300, deviceScaleFactor: 2 }],
    vision: { enabled: false }, extraWaitMs: 0, output: { dir: path.join(temp, "out") } });
  expect(report.matrix[0].pageErrors?.some((message) => message.includes("viewport-pipeline-error"))).toBe(true);
  expect(report.matrix[0].findings.some((finding) => finding.type === "runtime-error")).toBe(true);
  expect(report.matrix[0].viewport.name).toBe("legacy");
  expect(report.matrix[0].findings[0].targetId).toBeUndefined();
});

it.each([false, true])("retries a touch that does not leave the IME open (transient resize=%s), without activating other inputs", async (transient) => {
  const session = await runtime.launch({ ...BUILTIN_DEVICES["chromium:desktop-1080p"], viewport: { width: 400, height: 600 }, isMobile: true, hasTouch: true });
  try {
    await session.page.setContent('<meta name="viewport" content="width=device-width"><footer style="position:fixed;bottom:0"><input id="edit"><input id="send" type="submit" value="Send" onclick="document.body.dataset.sent=\'yes\'"></footer>');
    const tap = session.control.tap.bind(session.control);
    const touches = vi.spyOn(session.control, "tap").mockImplementation(async (x, y) => {
      await tap(x, y);
      if (transient && touches.mock.calls.length === 1) await session.page.evaluate(() => {
        // Reproduce the device's early resize that disappears before the settled measurement.
        const viewport = window.visualViewport!;
        Object.defineProperty(viewport, "height", { configurable: true, value: 300 });
        setTimeout(() => Reflect.deleteProperty(viewport, "height"), 150);
      });
      if (touches.mock.calls.length === 2) await session.page.setViewportSize({ width: 400, height: 320 });
    });
    // Synthetic device-frame transport, only for the probe's browser regression test.
    session.control.deviceScreenshot = async () => session.page.screenshot();
    const capture = await captureCurrentState({ session, url: "about:blank", renderId: "ime-retry", renderDir: temp, fullPage: false, probeKeyboard: true });
    expect(capture.metadata.keyboardProbes).toHaveLength(1);
    expect(capture.metadata.keyboardProbes![0]).toMatchObject({ selector: "#edit", keyboardShown: true, focused: true, attempts: 2, stable: true });
    expect(touches).toHaveBeenCalledTimes(2);
    expect(await session.page.evaluate(() => document.body.dataset.sent)).toBeUndefined();
  } finally { await session.close(); }
});

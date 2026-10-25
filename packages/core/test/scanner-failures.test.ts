import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { DeviceRegistry, BUILTIN_DEVICES } from "../src/runtime/registry.js";
import { PlaywrightRuntime } from "../src/runtime/playwright.js";
import { scan, reportFails } from "../src/scanner.js";

it("retains failed devices in the report and fails CI instead of reporting a partial scan as clean", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "ps-capture-errors-"));
  const registry = new DeviceRegistry();
  const runtime = new PlaywrightRuntime();
  const broken = { ...BUILTIN_DEVICES["chromium:desktop-1080p"], id: "test:broken", name: "Broken browser" };
  registry.registerDevice(broken);
  registry.registerRuntime("playwright", {
    name: "test-runtime", isAvailable: async () => ({ available: true }), shutdown: () => runtime.shutdown(),
    launch: async (target) => {
      if (target.id === broken.id) throw new Error("Device disconnected");
      return runtime.launch(target);
    }
  });
  try {
    const report = await scan({
      target: path.resolve(__dirname, "../../../fixtures/clean"), devices: ["test:broken", "chromium:desktop-1080p"],
      vision: { enabled: false }, extraWaitMs: 0, output: { dir: output }
    }, { registry });
    expect(report.matrix).toHaveLength(1);
    expect(report.errors).toEqual([{ targetId: "test:broken", message: "Device disconnected" }]);
    expect(report.summary.totalViewports).toBe(2);
    expect(report.summary.failedViewports).toBe(1);
    expect(report.summary.passedViewports).toBe(1);
    expect(reportFails(report, "none")).toBe(true);
    const persisted = JSON.parse(await fs.readFile(path.join(output, "report.json"), "utf8"));
    expect(persisted.errors).toEqual(report.errors);
  } finally { await registry.shutdownAll(); await fs.rm(output, { recursive: true, force: true }); }
});

it("reports requested vision being unavailable rather than implying that vision checks ran", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "ps-vision-unavailable-"));
  vi.stubEnv("OPENAI_API_KEY", "");
  try {
    const report = await scan({ target: path.resolve(__dirname, "../../../fixtures/clean"),
      devices: ["chromium:desktop-1080p"], vision: { enabled: true }, extraWaitMs: 0, output: { dir: output } });
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("heuristic checks only")]));
    expect(report.summary.totalFindings).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(output, "report.json"), "utf8")).warnings).toEqual(report.warnings);
  } finally { vi.unstubAllEnvs(); await fs.rm(output, { recursive: true, force: true }); }
});

it("captures uncaught exceptions, unhandled rejections and console errors in a Phase 1 scan", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-page-errors-"));
  const project = path.join(temp, "project"), output = path.join(temp, "out");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "index.html"), `<h1>Runtime fixture</h1><script>
    console.error('phase-one-console');
    Promise.reject(new Error('phase-one-rejection'));
    throw new Error('phase-one-crash');
  </script>`);
  try {
    const report = await scan({ target: project, devices: ["chromium:desktop-1080p"], vision: { enabled: false },
      extraWaitMs: 10, output: { dir: output } });
    expect(report.matrix[0].pageErrors).toEqual(expect.arrayContaining([expect.stringContaining("phase-one-crash"), expect.stringContaining("phase-one-rejection")]));
    expect(report.matrix[0].consoleErrors).toContain("phase-one-console");
    const errors = report.matrix[0].findings.filter((finding) => finding.type === "runtime-error");
    expect(errors).toHaveLength(3); expect(new Set(errors.map((finding) => finding.id)).size).toBe(3);
    expect(reportFails(report, "critical")).toBe(true);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

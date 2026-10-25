import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { explore } from "../src/explore/run.js";
import { scan, reportFails } from "../src/scanner.js";
import { BUILTIN_DEVICES, DeviceRegistry } from "../src/runtime/registry.js";
import { PlaywrightRuntime } from "../src/runtime/playwright.js";

let temp: string;
const fixture = '<meta name="viewport" content="width=device-width"><h1>Home</h1><button id="open" onclick="document.body.innerHTML=\'<h1>Details</h1><section><button id=next>Next</button></section>\'">Open details</button>';
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-run-budget-")); });
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });

it("shares the action cap across the pilot and replay, retaining partial captures and failing CI", async () => {
  const project = path.join(temp, "project"); await fs.mkdir(project); await fs.writeFile(path.join(project, "index.html"), fixture);
  const output = path.join(temp, "out");
  const { report, result } = await explore({ target: project, devices: ["chromium:desktop-1080p", "chromium:desktop-1440p"],
    budget: { maxActions: 1 }, vision: { enabled: false }, extraWaitMs: 0, output: { dir: output } },
  { maxSteps: 1, maxStates: 3, useMockAgent: true });
  expect(result.states).toHaveLength(2); expect(report.matrix).toHaveLength(3);
  expect(result.replays[0].success).toBe(false);
  expect(report.usage).toMatchObject({ actions: 1, requests: 0, totalTokens: 0, costUsd: 0, stopped: { kind: "actions" } });
  expect(reportFails(report, "none")).toBe(true);
  const saved = JSON.parse(await fs.readFile(path.join(output, "report.json"), "utf8"));
  expect(saved.errors.some((error: { targetId: string }) => error.targetId === "budget")).toBe(true);
  expect(saved.usage.actions).toBe(1);
  expect(await fs.readFile(path.join(project, "index.html"), "utf8")).toBe(fixture);
});

it("replays only captured states when the shared state cap is lower than the agent limit", async () => {
  const project = path.join(temp, "project"); await fs.mkdir(project); await fs.writeFile(path.join(project, "index.html"), fixture);
  const output = path.join(temp, "out");
  const { report, result } = await explore({ target: project, devices: ["chromium:desktop-1080p", "chromium:desktop-1440p"], budget: { maxStates: 1 },
    vision: { enabled: false }, extraWaitMs: 0, output: { dir: output } }, { maxSteps: 3, maxStates: 3, useMockAgent: true });
  expect(result.trace.steps).toHaveLength(0); expect(result.trace.discoveredStates).toHaveLength(1);
  expect(result.replays[0].success).toBe(true); expect(report.matrix).toHaveLength(2); expect(report.errors).toBeUndefined();
  expect(report.usage?.actions).toBe(0);
});

it("bounds unique discovery across per-device exploration without counting repeated states twice", async () => {
  const project = path.join(temp, "project"); await fs.mkdir(project);
  await fs.writeFile(path.join(project, "index.html"), fixture + '<script>if(innerWidth<600)document.body.insertAdjacentHTML("beforeend","<aside>Mobile only</aside>")</script>');
  const phone = { ...BUILTIN_DEVICES["chromium:desktop-1080p"], id: "custom:phone", name: "Custom phone", viewport: { width: 390, height: 844 } };
  const { report, result } = await explore({ target: project, devices: ["chromium:desktop-1080p", phone],
    vision: { enabled: false }, extraWaitMs: 0, output: { dir: path.join(temp, "out") } },
  { maxSteps: 1, maxStates: 2, perDevice: true, useMockAgent: true });
  expect(report.usage?.states).toBe(2); expect(report.usage?.stateLimitReached).toBe(true);
  expect(result.replays[0].success).toBe(false);
  expect(report.errors?.some((error) => error.targetId === "custom:phone" && error.message.includes("state limit"))).toBe(true);
  expect(reportFails(report, "none")).toBe(true);
});

it("interrupts an actual pending browser navigation at the scan deadline and saves the stop reason", async () => {
  let contacted = false, disconnected = false;
  const server = createServer((_request, response) => {
    contacted = true; response.on("close", () => { disconnected = true; });
    // Intentionally never respond: the scan deadline, not a server timeout, must stop navigation.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const runtime = new PlaywrightRuntime(), registry = new DeviceRegistry();
  const target = { ...BUILTIN_DEVICES["chromium:desktop-1080p"], id: "custom:pending" };
  registry.registerDevice(target);
  const session = await runtime.launch(target);
  registry.registerRuntime("playwright", { name: "prewarmed", isAvailable: async () => ({ available: true }), launch: async () => session, shutdown: () => runtime.shutdown() });
  try {
    const address = server.address() as { port: number };
    const report = await scan({ target: `http://127.0.0.1:${address.port}`, devices: [target.id], budget: { maxMinutes: 0.005 },
      vision: { enabled: false }, output: { dir: path.join(temp, "out") } }, { registry });
    expect(contacted).toBe(true); expect(disconnected).toBe(true);
    expect(report.usage?.stopped?.kind).toBe("time"); expect(report.matrix).toHaveLength(0);
    expect(reportFails(report, "none")).toBe(true); expect(session.page.isClosed()).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(temp, "out/report.json"), "utf8")).usage.stopped.kind).toBe("time");
  } finally { await runtime.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

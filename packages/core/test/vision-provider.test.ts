import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/vision/openai-provider.js";
import { processAndTileScreenshot } from "../src/vision/tile.js";
import type { RenderContext } from "../src/vision/types.js";
import { scan } from "../src/scanner.js";
import { RunBudget } from "../src/budget.js";
import { bindVisionProvider } from "../src/vision/index.js";

const { request, sdkOptions } = vi.hoisted(() => ({ request: vi.fn(), sdkOptions: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  constructor(options: unknown) { sdkOptions(options); }
  chat = { completions: { create: request } };
} }));
let temp: string;
const context: RenderContext = {
  renderConfig: { name: "DPR2", renderId: "dpr2", width: 400, height: 300, deviceScaleFactor: 2, isMobile: false, hasTouch: false, orientation: "portrait" },
  imageWidth: 400, imageHeight: 1000, originX: 0, originY: 0,
  domSnapshot: { document: { innerWidth: 400, innerHeight: 300, scrollWidth: 400, scrollHeight: 1000, devicePixelRatio: 2 }, elements: [{
    id: "el-1", selector: "#marker", tagName: "button", text: "Target marker", isInteractive: true, isClipped: false, parentId: null,
    rect: { x: 100, y: 325, left: 100, top: 325, right: 200, bottom: 350, width: 100, height: 25 },
    styles: { zIndex: 0, overflow: "visible", overflowX: "visible", overflowY: "visible", position: "static", display: "block", visibility: "visible", opacity: 1, fontSize: "16px", lineHeight: "20px", color: "black", backgroundColor: "white" },
    metrics: { scrollWidth: 100, scrollHeight: 25, clientWidth: 100, clientHeight: 25 }
  }] }
};
const response = (findings: unknown[] = []) => ({ choices: [{ message: { content: JSON.stringify({ findings }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const image = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#eee" } }).png().toBuffer();
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-vision-offline-")); vi.stubEnv("OPENAI_API_KEY", ""); });
afterEach(async () => { vi.unstubAllEnvs(); request.mockReset(); sdkOptions.mockReset(); await fs.rm(temp, { recursive: true, force: true }); });

it("bounds both tile dimensions, covers the image, and makes progress with tiny limits", async () => {
  const tiles = await processAndTileScreenshot(await image(1200, 5000), 256);
  expect(tiles[0].offsetY).toBe(0); expect(tiles.at(-1)!.offsetY + tiles.at(-1)!.tileHeight).toBe(5000);
  for (const [index, tile] of tiles.entries()) {
    const pixels = await sharp(tile.buffer).metadata();
    expect(pixels.width).toBeLessThanOrEqual(256); expect(pixels.height).toBeLessThanOrEqual(256);
    if (index) {
      expect(tile.offsetY).toBeGreaterThan(tiles[index - 1].offsetY);
      expect(tile.offsetY).toBeLessThan(tiles[index - 1].offsetY + tiles[index - 1].tileHeight);
    }
  }
  expect((await processAndTileScreenshot(await image(5, 10), 1)).length).toBeGreaterThan(0);
  await expect(processAndTileScreenshot(await image(5, 10), 0)).rejects.toThrow(/positive integer/);
});

it("grounds DPR2 tiles, deduplicates seam findings, and caches only matching image/context settings", async () => {
  request.mockImplementation(async () => {
    const index = (request.mock.calls.length - 1) % 3;
    return response(index === 2 ? [] : [{ type: "clipped-element", severity: "warning", confidence: 0.8, description: "Same seam defect", targetElementHint: "#marker",
      bbox: { xmin: 0.25, xmax: 0.5, ymin: index === 0 ? 650 / 800 : 50 / 800, ymax: index === 0 ? 700 / 800 : 100 / 800 } }]);
  });
  const provider = new OpenAIProvider({ apiKey: "offline-sdk-test", cacheDir: temp, maxImageDim: 400 });
  const buffer = await image(800, 2000);
  const result = await provider.analyze(buffer, context);
  expect(result.findings).toHaveLength(1); expect(result.findings[0].bbox).toEqual({ xmin: 0.25, xmax: 0.5, ymin: 0.325, ymax: 0.35 });
  expect(result.findings[0].type).toBe("text-clipping");
  expect(result.usage?.totalTokens).toBe(45); expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[0][0].messages[1].content[0].text).toContain('y:0.81-0.88, x:0.25-0.50');
  expect(request.mock.calls[1][0].messages[1].content[0].text).toContain('y:0.06-0.13, x:0.25-0.50');
  for (const [payload] of request.mock.calls) {
    const pixels = await sharp(Buffer.from(payload.messages[1].content[1].image_url.url.split(",")[1], "base64")).metadata();
    expect(pixels.width).toBeLessThanOrEqual(400); expect(pixels.height).toBeLessThanOrEqual(400);
  }
  const cached = await provider.analyze(buffer, context);
  expect(cached.cached).toBe(true); expect(cached.usage?.totalTokens).toBe(0); expect(cached.findings).toEqual(result.findings);
  expect(request).toHaveBeenCalledTimes(3);
  const changed = structuredClone(context); changed.domSnapshot.elements[0].text = "Different DOM context";
  expect((await provider.analyze(buffer, changed)).cached).toBe(false); expect(request).toHaveBeenCalledTimes(6);
});

it("retries a transient failure once with SDK retries disabled", async () => {
  request.mockRejectedValueOnce(Object.assign(new Error("Rate limited"), { status: 429 })).mockResolvedValue(response());
  const provider = new OpenAIProvider({ apiKey: "offline-sdk-test", cacheDir: temp });
  expect((await provider.analyze(await image(40, 40), context)).cached).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
  expect(sdkOptions).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0, timeout: 30000 }));
});

it("rejects invalid model geometry and never caches an incomplete analysis", async () => {
  request.mockResolvedValue(response([{ type: "clipped-element", severity: "warning", confidence: 0.8, description: "Inverted box",
    bbox: { xmin: 0.9, xmax: 0.2, ymin: 0.1, ymax: 0.2 } }]));
  const provider = new OpenAIProvider({ apiKey: "offline-sdk-test", cacheDir: temp });
  const buffer = await image(40, 40);
  await expect(provider.analyze(buffer, context)).rejects.toThrow(/Empty or inverted/);
  expect(request).toHaveBeenCalledTimes(3); expect(await fs.readdir(temp)).toEqual([]);
  request.mockResolvedValue(response());
  expect((await provider.analyze(buffer, context)).cached).toBe(false); expect(request).toHaveBeenCalledTimes(4);
});

it("persists a vision failure warning while retaining heuristic results", async () => {
  request.mockRejectedValue(Object.assign(new Error("Bad request from offline SDK fixture"), { status: 400 }));
  const provider = new OpenAIProvider({ apiKey: "offline-sdk-test", cacheDir: path.join(temp, "cache") });
  const report = await scan({ target: path.resolve(__dirname, "../../../fixtures/clean"), devices: ["chromium:desktop-1080p"],
    vision: { enabled: true }, extraWaitMs: 0, output: { dir: path.join(temp, "out") } }, { visionProvider: provider });
  expect(request).toHaveBeenCalledTimes(1);
  expect(report.usage?.phases.vision).toMatchObject({ requests: 1, uncertainRequests: 1 });
  expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Vision analysis failed")]));
  const item = report.matrix[0];
  const metadata = JSON.parse(await fs.readFile(path.join(temp, "out", path.dirname(item.screenshotRelPath), "meta.json"), "utf8"));
  expect(metadata.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Bad request from offline SDK fixture")]));
});

it("binds an injected OpenAI provider to each job without mutating its ledger or rebuilding its client", async () => {
  request.mockResolvedValue(response());
  const original = new RunBudget(), first = new RunBudget({ maxTokens: 0, models: { "gpt-4o": { contextTokens: 100 } } });
  const second = new RunBudget();
  const provider = new OpenAIProvider({ apiKey: "offline-sdk-test", cacheDir: temp, budget: original });
  const buffer = await image(40, 40);
  try {
    await expect(bindVisionProvider(provider, first).analyze(buffer, context)).rejects.toThrow(/token budget/);
    expect(request).not.toHaveBeenCalled();
    await bindVisionProvider(provider, second).analyze(buffer, context);
    expect(second.snapshot()).toMatchObject({ requests: 1, totalTokens: 15 });
    expect(original.snapshot().requests).toBe(0); expect(first.snapshot().requests).toBe(0);
    expect(sdkOptions).toHaveBeenCalledTimes(1);
  } finally { original.dispose(); first.dispose(); second.dispose(); }
});

it("rejects unmetered injected providers and aborts a hanging offline provider at the job deadline", async () => {
  const capped = new RunBudget({ maxTokens: 0 });
  let invoked = false;
  const unknown = bindVisionProvider({ name: "custom-paid", analyze: async () => { invoked = true; return { findings: [] }; } }, capped);
  try {
    await expect(unknown.analyze(Buffer.alloc(0), context)).rejects.toThrow(/withBudget/);
    expect(invoked).toBe(false); expect(capped.snapshot().stopped?.kind).toBe("configuration");
  } finally { capped.dispose(); }
  const deadline = new RunBudget({ maxMinutes: 0.001 });
  let signal: AbortSignal | undefined;
  const offline = bindVisionProvider({ name: "offline-hang", offline: true,
    analyze: async (_image, _context, options) => { signal = options?.signal; return new Promise(() => {}); } }, deadline);
  try {
    await expect(offline.analyze(Buffer.alloc(0), context)).rejects.toThrow(/time budget/);
    expect(signal?.aborted).toBe(true); expect(deadline.snapshot().requests).toBe(0);
  } finally { deadline.dispose(); }
});

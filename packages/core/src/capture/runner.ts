import { chromium, devices, type Browser } from "playwright";
import type { RenderConfig, ScanConfig } from "../config/schema.js";
import { captureSession } from "./session.js";
import type { CaptureResult } from "./types.js";
import { PlaywrightControl } from "../runtime/playwright.js";
import type { DeviceTarget } from "../runtime/types.js";
import { globalDeviceRegistry } from "../runtime/registry.js";
import { BrowserSlot } from "../runtime/browser-slot.js";

export interface CaptureProgressCallback {
  (completed: number, total: number, currentRenderId: string): void;
}

export class CaptureRunner {
  private browser: Browser | null = null;
  private browserSlot = new BrowserSlot();
  private closed = false;

  async init(): Promise<void> {
    if (this.closed) throw new Error("Capture runner has closed");
    if (!this.browser) {
      this.browser = await this.browserSlot.get(() => chromium.launch({
        headless: true,
        args: [
          "--disable-animations",
          "--disable-dev-shm-usage",
          "--no-sandbox"
        ]
      }));
    }
  }

  async close(): Promise<void> {
    this.closed = true; this.browser = null;
    await this.browserSlot.close();
  }

  async captureOne(
    url: string,
    renderConfig: RenderConfig,
    scanConfig: ScanConfig,
    outputBaseDir: string
  ): Promise<CaptureResult> {
    if (this.closed) throw new Error("Capture runner has closed");
    if (!this.browser) {
      await this.init();
    }

    const browser = this.browser!;
    let contextOptions: Record<string, unknown> = {
      viewport: {
        width: renderConfig.width,
        height: renderConfig.height
      },
      deviceScaleFactor: renderConfig.deviceScaleFactor,
      isMobile: renderConfig.isMobile,
      hasTouch: renderConfig.hasTouch
    };

    if (renderConfig.deviceDescriptor && devices[renderConfig.deviceDescriptor]) {
      contextOptions = {
        ...devices[renderConfig.deviceDescriptor],
        viewport: {
          width: renderConfig.width,
          height: renderConfig.height
        },
        deviceScaleFactor: renderConfig.deviceScaleFactor
      };
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    let target: DeviceTarget = globalDeviceRegistry.resolveTarget(renderConfig);
    const control = new PlaywrightControl(page, () => target, (next) => { target = next; });
    try {
      const capture = await captureSession({ id: renderConfig.renderId, get target() { return target; }, page, control, warnings: [], close: async () => {} },
        url, scanConfig, outputBaseDir, renderConfig.renderId);
      // Legacy viewport identity and descriptor geometry remain the caller's
      // configuration; the shared pipeline adds capture bounds and errors.
      capture.renderConfig = renderConfig;
      capture.metadata.viewport = renderConfig;
      await fs.writeFile(capture.metaPath, JSON.stringify(capture.metadata, null, 2));
      return capture;
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  async captureAll(
    url: string,
    renderConfigs: RenderConfig[],
    scanConfig: ScanConfig,
    outputBaseDir: string,
    onProgress?: CaptureProgressCallback,
    onCapture?: (capture: CaptureResult) => void
  ): Promise<CaptureResult[]> {
    await this.init();

    const results: CaptureResult[] = [];
    const total = renderConfigs.length;
    let completed = 0;

    // Concurrency pool
    const concurrency = Math.max(1, scanConfig.concurrency);
    const queue = [...renderConfigs];

    const worker = async () => {
      while (queue.length > 0) {
        const config = queue.shift();
        if (!config) break;

        const result = await this.captureOne(url, config, scanConfig, outputBaseDir);
        results.push(result);
        onCapture?.(result);
        completed++;
        if (onProgress) {
          onProgress(completed, total, config.renderId);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);

    // Keep deterministic ordering matching input renderConfigs
    const orderMap = new Map(renderConfigs.map((c, i) => [c.renderId, i]));
    results.sort(
      (a, b) =>
        (orderMap.get(a.renderConfig.renderId) ?? 0) -
        (orderMap.get(b.renderConfig.renderId) ?? 0)
    );

    return results;
  }
}
import fs from "node:fs/promises";

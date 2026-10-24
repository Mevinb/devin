import fs from "node:fs/promises";
import path from "node:path";
import { chromium, devices, type Browser } from "playwright";
import type { RenderConfig, ScanConfig } from "../config/schema.js";
import { extractDOMSnapshotInBrowser } from "./dom-snapshot.js";
import type { CaptureMetadata, CaptureResult, DOMSnapshot, FailedRequest } from "./types.js";

const DISABLE_ANIMATIONS_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
`;

export interface CaptureProgressCallback {
  (completed: number, total: number, currentRenderId: string): void;
}

export class CaptureRunner {
  private browser: Browser | null = null;

  async init(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-animations",
          "--disable-dev-shm-usage",
          "--no-sandbox"
        ]
      });
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async captureOne(
    url: string,
    renderConfig: RenderConfig,
    scanConfig: ScanConfig,
    outputBaseDir: string
  ): Promise<CaptureResult> {
    if (!this.browser) {
      await this.init();
    }

    const browser = this.browser!;
    const renderDir = path.join(outputBaseDir, "renders", renderConfig.renderId);
    await fs.mkdir(renderDir, { recursive: true });

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

    const consoleErrors: string[] = [];
    const failedRequests: FailedRequest[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    page.on("requestfailed", (req) => {
      failedRequests.push({
        url: req.url(),
        error: req.failure()?.errorText || "Unknown network failure"
      });
    });

    page.on("response", (res) => {
      if (res.status() >= 400) {
        failedRequests.push({
          url: res.url(),
          status: res.status()
        });
      }
    });

    try {
      await page.goto(url, {
        waitUntil: scanConfig.waitUntil,
        timeout: 30000
      });

      // Inject style to kill animations and transitions
      await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });

      // Wait for font loading
      await page.evaluate(async () => {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
        }
      });

      // Extra stabilization wait
      if (scanConfig.extraWaitMs > 0) {
        await new Promise((r) => setTimeout(r, scanConfig.extraWaitMs));
      }

      // Extract DOM snapshot
      const domSnapshot = (await page.evaluate(
        extractDOMSnapshotInBrowser
      )) as DOMSnapshot;

      // Check horizontal overflow
      const hasHorizontalScroll =
        domSnapshot.document.scrollWidth > domSnapshot.document.innerWidth + 2;

      // Capture screenshot
      const screenshotBuffer = await page.screenshot({
        fullPage: scanConfig.fullPage,
        type: "png"
      });

      const screenshotPath = path.join(renderDir, "screenshot.png");
      const domPath = path.join(renderDir, "dom.json");
      const metaPath = path.join(renderDir, "meta.json");

      await fs.writeFile(screenshotPath, screenshotBuffer);
      await fs.writeFile(domPath, JSON.stringify(domSnapshot, null, 2), "utf8");

      const metadata: CaptureMetadata = {
        renderId: renderConfig.renderId,
        viewport: renderConfig,
        url,
        timestamp: new Date().toISOString(),
        consoleErrors,
        failedRequests,
        hasHorizontalScroll,
        screenshotPath,
        domPath,
        dimensions: {
          viewportWidth: renderConfig.width,
          viewportHeight: renderConfig.height,
          pageWidth: domSnapshot.document.scrollWidth,
          pageHeight: domSnapshot.document.scrollHeight
        }
      };

      await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), "utf8");

      return {
        renderConfig,
        screenshotBuffer,
        screenshotPath,
        domSnapshot,
        domPath,
        metadata,
        metaPath
      };
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
    onProgress?: CaptureProgressCallback
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

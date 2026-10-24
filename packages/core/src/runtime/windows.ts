import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  DeviceAvailability,
  DeviceControl,
  DeviceRuntime,
  DeviceSession,
  DeviceTarget
} from "./types.js";

export class WindowsControl implements DeviceControl {
  constructor(
    private readonly page: Page,
    private readonly getTarget: () => DeviceTarget,
    private readonly setTarget: (t: DeviceTarget) => void
  ) {}

  async tap(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
  }

  async typeText(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async scroll(
    direction: "up" | "down" | "left" | "right",
    amount = 300
  ): Promise<void> {
    await this.page.evaluate(
      ({ dir, dist }) => {
        const deltaX = dir === "left" ? -dist : dir === "right" ? dist : 0;
        const deltaY = dir === "up" ? -dist : dir === "down" ? dist : 0;
        window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
      },
      { dir: direction, dist: amount }
    );
  }

  async rotate(): Promise<void> {
    // Windows desktop typically does not rotate, but handle display orientation switch if requested
  }

  async setKeyboardVisible(): Promise<void> {
    // Windows desktop has a physical keyboard by default
  }

  async back(): Promise<void> {
    await this.page.goBack();
  }

  async captureScreenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: "png" });
  }
}

export class WindowsRuntime implements DeviceRuntime {
  readonly name = "windows";
  private browser: Browser | null = null;
  private remoteUrl: string | null = process.env.PIXELSENTINEL_WINDOWS_CDP_URL || null;

  setRemoteUrl(url: string | null): void {
    this.remoteUrl = url;
  }

  async isAvailable(): Promise<DeviceAvailability> {
    if (this.remoteUrl) {
      try {
        const browser = await chromium.connectOverCDP(this.remoteUrl, { timeout: 3000 });
        await browser.close().catch(() => {});
        return {
          available: true,
          details: { remoteEndpoint: this.remoteUrl, type: "remote-cdp" }
        };
      } catch (err: unknown) {
        return {
          available: false,
          reason: `Remote Windows CDP endpoint unreachable: ${(err as Error).message}`
        };
      }
    }

    return {
      available: true,
      reason: "Local Windows desktop profile simulation (approximate fidelity)"
    };
  }

  async launch(target: DeviceTarget): Promise<DeviceSession> {
    let page: Page;
    let context: BrowserContext | null = null;
    let isRealRemote = false;

    if (this.remoteUrl) {
      try {
        const browser = await chromium.connectOverCDP(this.remoteUrl);
        const contexts = browser.contexts();
        context = contexts.length > 0 ? contexts[0] : await browser.newContext();
        page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        isRealRemote = true;
      } catch {
        // Fall back to local simulation
      }
    }

    if (!page!) {
      if (!this.browser) {
        this.browser = await chromium.launch({
          headless: true,
          args: ["--disable-animations", "--disable-dev-shm-usage", "--no-sandbox"]
        });
      }

      context = await this.browser.newContext({
        viewport: target.viewport,
        deviceScaleFactor: target.deviceScaleFactor,
        isMobile: false,
        hasTouch: false,
        userAgent:
          target.userAgent ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0"
      });
      page = await context.newPage();
    }

    let currentTarget: DeviceTarget = {
      ...target,
      fidelity: (isRealRemote ? "real" : "approximate") as DeviceTarget["fidelity"]
    };

    const control = new WindowsControl(
      page,
      () => currentTarget,
      (next) => {
        currentTarget = next;
      }
    );

    const sessionId = `win-${crypto.randomUUID().slice(0, 8)}`;

    return {
      id: sessionId,
      target: currentTarget,
      page,
      control,
      close: async () => {
        await page.close().catch(() => {});
        if (context && !isRealRemote) {
          await context.close().catch(() => {});
        }
      }
    };
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

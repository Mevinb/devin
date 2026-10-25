import crypto from "node:crypto";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { BrowserSlot } from "./browser-slot.js";
import type {
  DeviceAvailability,
  DeviceControl,
  DeviceRuntime,
  DeviceSession,
  DeviceTarget
} from "./types.js";

export class PlaywrightControl implements DeviceControl {
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

  async rotate(orientation: "portrait" | "landscape"): Promise<void> {
    const current = this.getTarget();
    const { width, height } = current.viewport;
    const isPortrait = height >= width;
    if ((orientation === "portrait" && !isPortrait) || (orientation === "landscape" && isPortrait)) {
      const newViewport = { width: height, height: width };
      await this.page.setViewportSize(newViewport);
      this.setTarget({
        ...current,
        orientation,
        viewport: newViewport
      });
    }
  }

  async setKeyboardVisible(visible: boolean): Promise<void> {
    const current = this.getTarget();
    // Simulate mobile soft keyboard taking up bottom 40% of viewport
    const kbHeight = Math.round(current.viewport.height * 0.4);
    if (visible) {
      await this.page.evaluate((h) => {
        (window as unknown as { __pixelSentinelKeyboardHeight?: number }).__pixelSentinelKeyboardHeight = h;
      }, kbHeight);
    } else {
      await this.page.evaluate(() => {
        delete (window as unknown as { __pixelSentinelKeyboardHeight?: number }).__pixelSentinelKeyboardHeight;
      });
    }
  }

  async back(): Promise<void> {
    await this.page.goBack();
  }

  async captureScreenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: "png" });
  }
}

export class PlaywrightRuntime implements DeviceRuntime {
  readonly name = "playwright";
  private chromiumBrowser = new BrowserSlot();
  private webkitBrowser = new BrowserSlot();

  async isAvailable(): Promise<DeviceAvailability> {
    return { available: true };
  }

  private async getBrowser(engine: "chromium" | "webkit"): Promise<Browser> {
    if (engine === "webkit") {
      return this.webkitBrowser.get(() => webkit.launch({ headless: true }));
    }
    return this.chromiumBrowser.get(() => chromium.launch({
        headless: true,
        args: ["--disable-animations", "--disable-dev-shm-usage", "--no-sandbox"]
      }));
  }

  async launch(target: DeviceTarget): Promise<DeviceSession> {
    const isWebKit = target.engine === "webkit" || target.id.startsWith("webkit:");
    const browser = await this.getBrowser(isWebKit ? "webkit" : "chromium");
    const modifiers = target.modifiers ?? {};
    let viewport = { ...target.viewport };
    const isPortrait = viewport.height >= viewport.width;
    if (
      (modifiers.orientation === "landscape" && isPortrait) ||
      (modifiers.orientation === "portrait" && !isPortrait)
    ) {
      viewport = { width: viewport.height, height: viewport.width };
    }

    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      viewport,
      deviceScaleFactor: target.deviceScaleFactor,
      isMobile: target.isMobile,
      hasTouch: target.hasTouch,
      userAgent: target.userAgent,
      colorScheme: modifiers.darkMode ? "dark" : undefined
    };

    const context: BrowserContext = await browser.newContext(contextOptions);
    const page: Page = await context.newPage();
    if (modifiers.fontScale && modifiers.fontScale !== 1) {
      await page.addInitScript((scale) => {
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.fontSize = `${scale * 100}%`;
        });
      }, modifiers.fontScale);
    }

    let currentTarget: DeviceTarget = {
      ...target,
      viewport,
      orientation: viewport.height >= viewport.width ? "portrait" : "landscape"
    };
    const control = new PlaywrightControl(
      page,
      () => currentTarget,
      (next) => {
        currentTarget = next;
      }
    );

    const sessionId = `pw-${crypto.randomUUID().slice(0, 8)}`;

    return {
      id: sessionId,
      get target() {
        return currentTarget;
      },
      page,
      control,
      warnings: [],
      close: async () => {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.chromiumBrowser.close(), this.webkitBrowser.close()]);
  }
}

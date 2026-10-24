import { exec } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import type {
  DeviceAvailability,
  DeviceControl,
  DeviceRuntime,
  DeviceSession,
  DeviceTarget
} from "./types.js";

const execAsync = promisify(exec);

export class AndroidControl implements DeviceControl {
  constructor(
    private readonly page: Page,
    private readonly serial: string | null,
    private readonly getTarget: () => DeviceTarget,
    private readonly setTarget: (t: DeviceTarget) => void
  ) {}

  private async runAdb(cmd: string): Promise<string> {
    if (!this.serial) return "";
    try {
      const { stdout } = await execAsync(`adb -s ${this.serial} ${cmd}`);
      return stdout;
    } catch {
      return "";
    }
  }

  async tap(x: number, y: number): Promise<void> {
    if (this.serial) {
      await this.runAdb(`shell input tap ${Math.round(x)} ${Math.round(y)}`);
    } else {
      await this.page.mouse.click(x, y);
    }
  }

  async typeText(text: string): Promise<void> {
    if (this.serial) {
      // Escape spaces and special shell characters
      const escaped = text.replace(/ /g, "%s").replace(/([&|;()<>\\*?#])/g, "\\$1");
      await this.runAdb(`shell input text "${escaped}"`);
    } else {
      await this.page.keyboard.type(text);
    }
  }

  async pressKey(key: string): Promise<void> {
    if (this.serial) {
      const keyMap: Record<string, number> = {
        Enter: 66,
        Escape: 111,
        Backspace: 67,
        Tab: 61,
        ArrowUp: 19,
        ArrowDown: 20,
        ArrowLeft: 21,
        ArrowRight: 22,
        Home: 3,
        Back: 4
      };
      const code = keyMap[key];
      if (code) {
        await this.runAdb(`shell input keyevent ${code}`);
        return;
      }
    }
    await this.page.keyboard.press(key);
  }

  async scroll(
    direction: "up" | "down" | "left" | "right",
    amount = 300
  ): Promise<void> {
    if (this.serial) {
      const target = this.getTarget();
      const midX = Math.round(target.viewport.width / 2);
      const midY = Math.round(target.viewport.height / 2);
      let startX = midX;
      let startY = midY;
      let endX = midX;
      let endY = midY;

      if (direction === "down") {
        startY = midY + Math.round(amount / 2);
        endY = midY - Math.round(amount / 2);
      } else if (direction === "up") {
        startY = midY - Math.round(amount / 2);
        endY = midY + Math.round(amount / 2);
      } else if (direction === "right") {
        startX = midX + Math.round(amount / 2);
        endX = midX - Math.round(amount / 2);
      } else if (direction === "left") {
        startX = midX - Math.round(amount / 2);
        endX = midX + Math.round(amount / 2);
      }

      await this.runAdb(`shell input swipe ${startX} ${startY} ${endX} ${endY} 250`);
    } else {
      await this.page.evaluate(
        ({ dir, dist }) => {
          const deltaX = dir === "left" ? -dist : dir === "right" ? dist : 0;
          const deltaY = dir === "up" ? -dist : dir === "down" ? dist : 0;
          window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
        },
        { dir: direction, dist: amount }
      );
    }
  }

  async rotate(orientation: "portrait" | "landscape"): Promise<void> {
    const current = this.getTarget();
    const { width, height } = current.viewport;
    const isPortrait = height >= width;
    if ((orientation === "portrait" && !isPortrait) || (orientation === "landscape" && isPortrait)) {
      const newViewport = { width: height, height: width };
      if (this.serial) {
        const userRotation = orientation === "landscape" ? 1 : 0;
        await this.runAdb(`shell settings put system accelerometer_rotation 0`);
        await this.runAdb(`shell settings put system user_rotation ${userRotation}`);
      }
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
    const kbHeight = Math.round(current.viewport.height * 0.4);
    if (visible) {
      await this.page.evaluate((h) => {
        (window as unknown as { __pixelSentinelKeyboardHeight?: number }).__pixelSentinelKeyboardHeight = h;
      }, kbHeight);
    } else {
      if (this.serial) {
        await this.runAdb(`shell input keyevent 111`); // Escape / dismiss keyboard
      }
      await this.page.evaluate(() => {
        delete (window as unknown as { __pixelSentinelKeyboardHeight?: number }).__pixelSentinelKeyboardHeight;
      });
    }
  }

  async back(): Promise<void> {
    if (this.serial) {
      await this.runAdb(`shell input keyevent 4`);
    } else {
      await this.page.goBack();
    }
  }

  async captureScreenshot(): Promise<Buffer> {
    if (this.serial) {
      try {
        const { stdout } = await execAsync(`adb -s ${this.serial} exec-out screencap -p`, {
          encoding: "buffer",
          maxBuffer: 25 * 1024 * 1024
        });
        if (stdout && stdout.length > 0) {
          return stdout;
        }
      } catch {
        // Fall back to CDP page screenshot
      }
    }
    return this.page.screenshot({ type: "png" });
  }
}

export class AndroidRuntime implements DeviceRuntime {
  readonly name = "android";
  private cdpBrowser: Browser | null = null;
  private localBrowser: Browser | null = null;

  async isAvailable(): Promise<DeviceAvailability> {
    try {
      const { stdout } = await execAsync("adb devices");
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("List of devices"));

      const onlineDevices = lines.filter((l) => l.endsWith("device"));
      if (onlineDevices.length > 0) {
        return {
          available: true,
          details: { onlineDevices: onlineDevices.map((d) => d.split(/\s+/)[0]) }
        };
      }
      return {
        available: false,
        reason: "No online Android emulator or physical device detected via ADB"
      };
    } catch (err: unknown) {
      return {
        available: false,
        reason: `ADB command failed: ${(err as Error).message}`
      };
    }
  }

  async launch(target: DeviceTarget): Promise<DeviceSession> {
    const availability = await this.isAvailable();
    let serial: string | null = null;
    let page: Page;
    let closeSession = async () => {};

    if (availability.available && availability.details?.onlineDevices) {
      const devices = availability.details.onlineDevices as string[];
      serial = devices[0];
      const cdpPort = 9222;

      // Forward DevTools socket over ADB
      try {
        await execAsync(`adb -s ${serial} forward tcp:${cdpPort} localabstract:chrome_devtools_remote`);
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
        this.cdpBrowser = browser;
        const contexts = browser.contexts();
        const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
        page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        closeSession = async () => {
          await page.close().catch(() => {});
        };
      } catch {
        // If chrome_devtools_remote is not active yet, fall back to headless emulation mode
        serial = null;
      }
    }

    if (!serial) {
      // Emulation mode using Chromium with Android target specifications
      if (!this.localBrowser) {
        this.localBrowser = await chromium.launch({
          headless: true,
          args: ["--disable-animations", "--disable-dev-shm-usage", "--no-sandbox"]
        });
      }
      const context = await this.localBrowser.newContext({
        viewport: target.viewport,
        deviceScaleFactor: target.deviceScaleFactor,
        isMobile: true,
        hasTouch: true,
        userAgent:
          target.userAgent ||
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36"
      });
      page = await context.newPage();
      closeSession = async () => {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      };
    }

    let currentTarget = {
      ...target,
      fidelity: (serial ? "real" : "approximate") as DeviceTarget["fidelity"]
    };

    const control = new AndroidControl(
      page!,
      serial,
      () => currentTarget,
      (next) => {
        currentTarget = next;
      }
    );

    const sessionId = `android-${crypto.randomUUID().slice(0, 8)}`;

    return {
      id: sessionId,
      target: currentTarget,
      page: page!,
      control,
      close: closeSession
    };
  }

  async shutdown(): Promise<void> {
    if (this.cdpBrowser) {
      await this.cdpBrowser.close().catch(() => {});
      this.cdpBrowser = null;
    }
    if (this.localBrowser) {
      await this.localBrowser.close().catch(() => {});
      this.localBrowser = null;
    }
  }
}

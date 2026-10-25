import type { Page } from "playwright";
import type { DeviceControl, DeviceTarget, Posture } from "../types.js";
import type { AdbClient } from "./adb.js";

const TV_KEYCODES: Record<string, number> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Enter: 23, // DPAD_CENTER
  Back: 4,
  Escape: 111,
  Home: 3
};

const PHONE_KEYCODES: Record<string, number> = {
  Back: 4,
  Home: 3
};

/** Control of a real Android emulator: system input via adb, in-page input via CDP. */
export class AndroidDeviceControl implements DeviceControl {
  private screenSize: { width: number; height: number } | null = null;

  constructor(
    private readonly page: Page,
    private readonly adb: AdbClient,
    private readonly serial: string,
    private readonly getTarget: () => DeviceTarget,
    private readonly setTarget: (t: DeviceTarget) => void
  ) {}

  private get isTV(): boolean {
    const t = this.getTarget();
    return Boolean(t.isTV || t.android?.input === "dpad");
  }

  private async physicalSize(): Promise<{ width: number; height: number }> {
    if (this.screenSize) return this.screenSize;
    const out = await this.adb.shell(this.serial, "wm size");
    const m = out.match(/Override size: (\d+)x(\d+)/) || out.match(/Physical size: (\d+)x(\d+)/);
    let width = m ? Number(m[1]) : 1080;
    let height = m ? Number(m[2]) : 1920;
    const rotation = (await this.adb.shell(this.serial, "settings get system user_rotation").catch(() => "0")).trim();
    if (rotation === "1" || rotation === "3") [width, height] = [height, width];
    this.screenSize = { width, height };
    return this.screenSize;
  }

  async tap(x: number, y: number): Promise<void> {
    // CDP touch goes through Chrome's real input pipeline on the device and uses CSS viewport coords,
    // which avoids guessing the browser toolbar offset needed for `adb input tap`.
    if (this.isTV) {
      await this.page.mouse.click(x, y);
    } else {
      await this.page.touchscreen.tap(x, y);
    }
  }

  async typeText(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  async pressKey(key: string): Promise<void> {
    const map = this.isTV ? TV_KEYCODES : PHONE_KEYCODES;
    const code = map[key] ?? (key.startsWith("DPAD_") || key.startsWith("KEYCODE_") ? key : undefined);
    if (code !== undefined) {
      await this.adb.keyevent(this.serial, code);
      return;
    }
    await this.page.keyboard.press(key);
  }

  async scroll(direction: "up" | "down" | "left" | "right", amount = 300): Promise<void> {
    if (this.isTV) {
      const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
      const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
      await this.page.mouse.wheel(dx, dy);
      return;
    }
    const { width, height } = await this.physicalSize();
    const dpr = this.getTarget().deviceScaleFactor || 2;
    const dist = Math.round(amount * dpr);
    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);
    const half = Math.round(dist / 2);
    const [sx, sy, ex, ey] =
      direction === "down"
        ? [cx, cy + half, cx, cy - half]
        : direction === "up"
          ? [cx, cy - half, cx, cy + half]
          : direction === "right"
            ? [cx + half, cy, cx - half, cy]
            : [cx - half, cy, cx + half, cy];
    await this.adb.shell(this.serial, `input swipe ${sx} ${sy} ${ex} ${ey} 400`);
  }

  async rotate(orientation: "portrait" | "landscape"): Promise<void> {
    const t = this.getTarget();
    // user_rotation is relative to the natural orientation (landscape for TV/tablet/auto, portrait for phones)
    const display = t.android?.display;
    const naturalLandscape = display ? display.width > display.height : t.viewport.width > t.viewport.height && !t.isMobile;
    const rotation = (orientation === "landscape") === naturalLandscape ? 0 : 1;
    await this.adb.shell(this.serial, "settings put system accelerometer_rotation 0");
    await this.adb.shell(this.serial, `settings put system user_rotation ${rotation}`);
    this.screenSize = null;
    await this.page.waitForTimeout(1500);
    await this.refreshViewport();
  }

  async refreshViewport(): Promise<void> {
    const m = await this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio
    }));
    const t = this.getTarget();
    this.setTarget({
      ...t,
      viewport: { width: m.width, height: m.height },
      deviceScaleFactor: m.dpr,
      orientation: m.height >= m.width ? "portrait" : "landscape"
    });
  }

  async setKeyboardVisible(visible: boolean): Promise<void> {
    if (visible) return; // the real IME appears when an input is focused via touch
    const ime = await this.adb.shell(this.serial, "dumpsys input_method").catch(() => "");
    if (/mInputShown=true|isInputViewShown=true/.test(ime)) {
      await this.adb.keyevent(this.serial, 4);
    }
  }

  async back(): Promise<void> {
    await this.adb.keyevent(this.serial, 4);
  }

  async captureScreenshot(): Promise<Buffer> {
    try {
      return await this.adb.captureScreenshot(this.serial);
    } catch {
      return this.page.screenshot({ type: "png" });
    }
  }

  async deviceScreenshot(): Promise<Buffer | null> {
    return this.adb.captureScreenshot(this.serial).catch(() => null);
  }

  async setPosture(posture: Posture): Promise<void> {
    if (!this.getTarget().isFoldable) throw new Error("This Android target does not support fold posture changes");
    const cmd = posture === "folded" ? "fold" : posture === "unfolded" ? "unfold" : "posture 2";
    const result = await this.adb.emu(this.serial, cmd);
    if (/\bKO:|unknown command|not supported/i.test(result)) throw new Error(`Emulator rejected posture '${posture}': ${result.trim()}`);
    this.screenSize = null;
    await this.page.waitForTimeout(2000);
    await this.refreshViewport();
  }

  async setFontScale(scale: number): Promise<void> {
    await this.adb.shell(this.serial, `settings put system font_scale ${scale}`);
    await this.page.waitForTimeout(800);
  }

  async setDarkMode(enabled: boolean): Promise<void> {
    await this.adb.shell(this.serial, `cmd uimode night ${enabled ? "yes" : "no"}`);
    await this.page.waitForTimeout(800);
  }
}

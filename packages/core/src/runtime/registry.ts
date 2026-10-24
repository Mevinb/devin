import type { ViewportConfig } from "../config/schema.js";
import { AndroidRuntime } from "./android.js";
import { PlaywrightRuntime } from "./playwright.js";
import type { DeviceRuntime, DeviceTarget } from "./types.js";
import { WindowsRuntime } from "./windows.js";

export const BUILTIN_DEVICES: Record<string, DeviceTarget> = {
  "chromium:desktop-1080p": {
    id: "chromium:desktop-1080p",
    name: "Desktop 1080p (Chromium)",
    runtime: "playwright",
    fidelity: "real",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false
  },
  "chromium:desktop-1440p": {
    id: "chromium:desktop-1440p",
    name: "Desktop 1440p (Chromium)",
    runtime: "playwright",
    fidelity: "real",
    viewport: { width: 2560, height: 1440 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false
  },
  "android:pixel-8": {
    id: "android:pixel-8",
    name: "Google Pixel 8",
    runtime: "android",
    fidelity: "approximate", // elevated to 'real' dynamically if emulator/device is connected
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    safeAreaInsets: { top: 48, right: 0, bottom: 24, left: 0 },
    notchRect: { x: 186, y: 0, width: 40, height: 40 }
  },
  "android:pixel-fold": {
    id: "android:pixel-fold",
    name: "Google Pixel Fold (Inner)",
    runtime: "android",
    fidelity: "approximate",
    viewport: { width: 840, height: 700 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    isFoldable: true,
    hingeRect: { x: 418, y: 0, width: 4, height: 700 },
    safeAreaInsets: { top: 24, right: 0, bottom: 24, left: 0 }
  },
  "android:tv-1080p": {
    id: "android:tv-1080p",
    name: "Android TV 1080p",
    runtime: "android",
    fidelity: "approximate",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1.5,
    isMobile: false,
    hasTouch: false,
    isTV: true
  },
  "webkit:iphone-15-pro": {
    id: "webkit:iphone-15-pro",
    name: "iPhone 15 Pro (WebKit)",
    runtime: "playwright",
    fidelity: "approximate",
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
    notchRect: { x: 134, y: 11, width: 125, height: 35 } // Dynamic Island
  },
  "webkit:ipad-pro-11": {
    id: "webkit:ipad-pro-11",
    name: "iPad Pro 11-inch (WebKit)",
    runtime: "playwright",
    fidelity: "approximate",
    viewport: { width: 834, height: 1194 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    safeAreaInsets: { top: 24, right: 0, bottom: 20, left: 0 }
  },
  "windows:desktop-4k": {
    id: "windows:desktop-4k",
    name: "Windows Desktop 4K (200% DPI)",
    runtime: "windows",
    fidelity: "approximate",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0"
  }
};

export class DeviceRegistry {
  private customDevices: Map<string, DeviceTarget> = new Map();
  private runtimes: Map<string, DeviceRuntime> = new Map();

  constructor() {
    this.runtimes.set("playwright", new PlaywrightRuntime());
    this.runtimes.set("android", new AndroidRuntime());
    this.runtimes.set("windows", new WindowsRuntime());
  }

  registerDevice(target: DeviceTarget): void {
    this.customDevices.set(target.id, target);
  }

  registerRuntime(name: string, runtime: DeviceRuntime): void {
    this.runtimes.set(name, runtime);
  }

  getRuntime(name: string): DeviceRuntime {
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new Error(`Device runtime '${name}' not registered.`);
    }
    return runtime;
  }

  resolveTarget(idOrConfig: string | DeviceTarget | ViewportConfig): DeviceTarget {
    if (typeof idOrConfig === "string") {
      const match = this.customDevices.get(idOrConfig) || BUILTIN_DEVICES[idOrConfig];
      if (match) return match;
      throw new Error(`Unknown device target '${idOrConfig}'. Available: ${Object.keys(BUILTIN_DEVICES).join(", ")}`);
    }

    if ("runtime" in idOrConfig && idOrConfig.runtime) {
      return idOrConfig as DeviceTarget;
    }

    // ViewportConfig fallback -> Chromium Playwright DeviceTarget
    const vp = idOrConfig as ViewportConfig;
    return {
      id: `viewport:${vp.name.toLowerCase().replace(/\s+/g, "-")}`,
      name: vp.name,
      runtime: "playwright",
      fidelity: "real",
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor ?? 1,
      isMobile: vp.isMobile ?? false,
      hasTouch: vp.hasTouch ?? false,
      orientation: vp.orientation ?? "landscape"
    };
  }

  listBuiltins(): DeviceTarget[] {
    return Object.values(BUILTIN_DEVICES);
  }

  async shutdownAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.shutdown().catch(() => {});
    }
  }
}

export const globalDeviceRegistry = new DeviceRegistry();

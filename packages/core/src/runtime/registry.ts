import type { ViewportConfig } from "../config/schema.js";
import { devices as playwrightDevices } from "playwright";
import { AndroidRuntime } from "./android/runtime.js";
import { AVD_PROFILES, getAvdProfile } from "./android/profiles.js";
import { PlaywrightRuntime } from "./playwright.js";
import type { DeviceLifecycleEvent, DeviceRuntime, DeviceTarget, TargetModifiers } from "./types.js";
import { WindowsRuntime } from "./windows.js";

const WIN_EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

/** Short names retained for callers; profile definitions are authoritative. */
export const AVD_NAMES = {
  phone: AVD_PROFILES.pixel_8.avdName,
  tablet: AVD_PROFILES.pixel_tablet.avdName,
  fold: AVD_PROFILES.pixel_fold.avdName,
  tv: AVD_PROFILES.android_tv_1080p.avdName,
  wear: AVD_PROFILES.wear_os_round.avdName,
  automotive: AVD_PROFILES.automotive_1024p.avdName
} as const;

function android(
  id: string,
  name: string,
  opts: Omit<DeviceTarget, "id" | "name" | "runtime" | "fidelity" | "android"> & { fidelity?: DeviceTarget["fidelity"] }
): DeviceTarget {
  const profile = getAvdProfile(id);
  if (!profile) throw new Error(`No AVD profile for built-in Android target '${id}'`);
  return {
    id: `android:${id}`,
    name,
    runtime: "android",
    // Upgraded to "real" (Chrome) or "webview" (shell APK) when the emulator session starts
    fidelity: "approximate",
    engine: "chromium",
    ...opts,
    android: {
      avd: profile.avdName, profile: profile.id,
      browser: ["phone", "tablet", "foldable"].includes(profile.deviceType) ? "chrome" : "webview-shell",
      display: { ...profile.resolution, density: profile.densityDpi },
      input: profile.deviceType === "tv" ? "dpad" : "touch"
    }
  };
}

function windows(id: string, name: string, browser: "msedge" | "chrome" | "firefox", width: number, height: number, scale: number): DeviceTarget {
  return {
    id: `windows:${id}`,
    name,
    runtime: "windows",
    fidelity: "approximate",
    engine: browser === "firefox" ? "firefox" : "chromium",
    viewport: { width: Math.round(width / scale), height: Math.round(height / scale) - 80 },
    deviceScaleFactor: scale,
    isMobile: false,
    hasTouch: false,
    userAgent: browser === "msedge" ? WIN_EDGE_UA : undefined,
    windows: { browser, scale }
  };
}

export const BUILTIN_DEVICES: Record<string, DeviceTarget> = {
  "chromium:desktop-1080p": {
    id: "chromium:desktop-1080p",
    name: "Desktop 1080p (Chromium)",
    runtime: "playwright",
    fidelity: "real",
    engine: "chromium",
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
    engine: "chromium",
    viewport: { width: 2560, height: 1440 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false
  },

  // ---- Android phones / tablets (one hardware profile per AVD, real Chrome) ----
  "android:pixel-8": android("pixel-8", "Google Pixel 8", {
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
    // Only relevant for pages using viewport-fit=cover (fullscreen / PWA)
    safeAreaInsets: { top: 48, right: 0, bottom: 24, left: 0 },
    notchRect: { x: 186, y: 0, width: 40, height: 40 },
  }),
  "android:pixel-8-pro": android("pixel-8-pro", "Google Pixel 8 Pro", {
    viewport: { width: 448, height: 998 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
    safeAreaInsets: { top: 48, right: 0, bottom: 24, left: 0 },
    notchRect: { x: 204, y: 0, width: 40, height: 40 },
  }),
  "android:small-phone": android("small-phone", "Compact Android Phone 5\"", {
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
  }),
  "android:tablet-7in": android("tablet-7in", "Android 7\" Tablet", {
    viewport: { width: 600, height: 960 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
  }),
  "android:pixel-tablet": android("pixel-tablet", "Google Pixel Tablet 11\"", {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    orientation: "landscape",
  }),

  // ---- Foldable (own AVD with hinge sensor) ----
  "android:pixel-fold": android("pixel-fold", "Google Pixel Fold", {
    viewport: { width: 841, height: 701 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    isFoldable: true,
    hingeRect: { x: 418, y: 0, width: 4, height: 701 },
  }),

  // ---- Form factors without Chrome: WebView shell ----
  "android:tv-1080p": android("tv-1080p", "Android TV 1080p", {
    viewport: { width: 960, height: 540 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    isTV: true,
    orientation: "landscape",
  }),
  "android:tv-4k": android("tv-4k", "Android TV 4K", {
    viewport: { width: 960, height: 540 },
    deviceScaleFactor: 4,
    isMobile: false,
    hasTouch: false,
    isTV: true,
    orientation: "landscape",
  }),
  "android:automotive": android("automotive", "Android Automotive 1024p", {
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: true,
    isAutomotive: true,
    orientation: "landscape",
  }),
  "android:wear-round": android("wear-round", "Wear OS Round 454px", {
    viewport: { width: 227, height: 227 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    isWearable: true,
    orientation: "portrait",
  }),

  // ---- iOS / macOS approximations (Playwright WebKit) ----
  "webkit:iphone-15-pro": {
    id: "webkit:iphone-15-pro",
    name: "iPhone 15 Pro (WebKit)",
    runtime: "playwright",
    fidelity: "approximate",
    engine: "webkit",
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
    notchRect: { x: 134, y: 11, width: 125, height: 35 } // Dynamic Island
  },
  "webkit:iphone-se": {
    id: "webkit:iphone-se",
    name: "iPhone SE (WebKit)",
    runtime: "playwright",
    fidelity: "approximate",
    engine: "webkit",
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    safeAreaInsets: { top: 20, right: 0, bottom: 0, left: 0 }
  },
  "webkit:ipad-pro-11": {
    id: "webkit:ipad-pro-11",
    name: "iPad Pro 11-inch (WebKit)",
    runtime: "playwright",
    fidelity: "approximate",
    engine: "webkit",
    viewport: { width: 834, height: 1194 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    safeAreaInsets: { top: 24, right: 0, bottom: 20, left: 0 }
  },
  "webkit:macbook-safari": {
    id: "webkit:macbook-safari",
    name: "MacBook Air Safari (WebKit)",
    runtime: "playwright",
    fidelity: "approximate",
    engine: "webkit",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false
  },

  // ---- Windows (real when a Windows VM / endpoint is configured) ----
  "windows:msedge-1080p": windows("msedge-1080p", "Windows 11 Edge 1080p", "msedge", 1920, 1080, 1),
  "windows:chrome-1080p": windows("chrome-1080p", "Windows 11 Chrome 1080p", "chrome", 1920, 1080, 1),
  "windows:firefox-1080p": windows("firefox-1080p", "Windows 11 Firefox 1080p", "firefox", 1920, 1080, 1),
  "windows:msedge-1440p-150": windows("msedge-1440p-150", "Windows 11 Edge 1440p @150%", "msedge", 2560, 1440, 1.5),
  "windows:desktop-4k": windows("desktop-4k", "Windows Desktop 4K (200% DPI)", "msedge", 3840, 2160, 2)
};

/** Parse `android:pixel-fold@folded@landscape@font1.3@dark` into base id + modifiers. */
export function parseDeviceId(spec: string): { baseId: string; modifiers: TargetModifiers } {
  const [baseId, ...parts] = spec.trim().split("@");
  const modifiers: TargetModifiers = {};
  for (const p of parts) {
    const v = p.toLowerCase();
    if (v === "portrait" || v === "landscape") modifiers.orientation = v;
    else if (v === "folded" || v === "unfolded" || v === "half-opened") modifiers.posture = v;
    else if (v === "dark") modifiers.darkMode = true;
    else if (v === "light") modifiers.darkMode = false;
    else if (/^font\d+(\.\d+)?$/.test(v)) modifiers.fontScale = Number(v.slice(4));
    else throw new Error(`Unknown device modifier '@${p}' in '${spec}'`);
  }
  return { baseId, modifiers };
}

export function applyModifiers(target: DeviceTarget, modifiers: TargetModifiers, spec: string): DeviceTarget {
  if (Object.keys(modifiers).length === 0) return target;
  const next: DeviceTarget = { ...target, id: spec, modifiers: { ...target.modifiers, ...modifiers } };
  const labels = [
    modifiers.posture,
    modifiers.orientation,
    modifiers.fontScale ? `font ${modifiers.fontScale}x` : undefined,
    modifiers.darkMode ? "dark" : undefined
  ].filter(Boolean);
  next.name = `${target.name} (${labels.join(", ")})`;
  if (modifiers.posture === "folded" && target.isFoldable) {
    // Outer display of Pixel Fold: no hinge in the viewport
    next.viewport = { width: 412, height: 883 };
    next.hingeRect = undefined;
  }
  return next;
}

export class DeviceRegistry {
  private customDevices: Map<string, DeviceTarget> = new Map();
  private runtimes: Map<string, DeviceRuntime> = new Map();

  constructor(private readonly onLifecycle?: (event: DeviceLifecycleEvent) => void) {
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
    if (!this.onLifecycle) return runtime;
    const emit = this.onLifecycle;
    return {
      name: runtime.name,
      isAvailable: (target) => runtime.isAvailable(target),
      shutdown: () => runtime.shutdown(),
      launch: async (target) => {
        const base = { targetId: target.id, name: target.name, runtime: target.runtime };
        emit({ ...base, phase: "booting" });
        try {
          const session = await runtime.launch(target);
          emit({ ...base, phase: "busy", fidelity: session.target.fidelity, deviceInfo: session.deviceInfo });
          return Object.create(session, { close: { value: async () => {
            await session.close();
            emit({ ...base, phase: "released", fidelity: session.target.fidelity, deviceInfo: session.deviceInfo });
          } } });
        } catch (err) {
          emit({ ...base, phase: "error", message: (err as Error).message });
          throw err;
        }
      }
    };
  }

  resolveTarget(idOrConfig: string | DeviceTarget | ViewportConfig): DeviceTarget {
    if (typeof idOrConfig === "string") {
      const { baseId, modifiers } = parseDeviceId(idOrConfig);
      const match = this.customDevices.get(baseId) || BUILTIN_DEVICES[baseId];
      if (match) return applyModifiers(match, modifiers, idOrConfig);
      throw new Error(`Unknown device target '${baseId}'. Available: ${Object.keys(BUILTIN_DEVICES).join(", ")}`);
    }

    if ("runtime" in idOrConfig && idOrConfig.runtime) {
      return idOrConfig as DeviceTarget;
    }

    // ViewportConfig fallback -> Chromium Playwright DeviceTarget
    const vp = idOrConfig as ViewportConfig;
    const descriptor = vp.deviceDescriptor ? BUILTIN_DEVICES[vp.deviceDescriptor] : undefined;
    const emulation = vp.deviceDescriptor ? playwrightDevices[vp.deviceDescriptor] : undefined;
    return {
      ...descriptor,
      id: `viewport:${vp.name.toLowerCase().replace(/\s+/g, "-")}`,
      name: vp.name,
      runtime: "playwright",
      fidelity: vp.isMobile || vp.deviceDescriptor ? "approximate" : "real",
      engine: "chromium",
      userAgent: emulation?.userAgent ?? descriptor?.userAgent,
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

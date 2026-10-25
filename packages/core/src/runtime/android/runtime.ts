import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  _android,
  chromium,
  type AndroidDevice,
  type Browser,
  type BrowserContext,
  type Page
} from "playwright";
import { PlaywrightControl } from "../playwright.js";
import { BrowserSlot } from "../browser-slot.js";
import type {
  DeviceAvailability,
  DeviceRuntime,
  DeviceSession,
  DeviceTarget
} from "../types.js";
import { AdbClient, defaultAdbClient } from "./adb.js";
import { AndroidDeviceControl } from "./control.js";
import { EmulatorManager, defaultEmulatorManager } from "./emulator.js";
import { avdExists, emulatorInstalled } from "./sdk.js";

export const SHELL_PACKAGE = "dev.pixelsentinel.shell";
const CHROME_PACKAGE = "com.android.chrome";

export function webViewShellApkPath(): string {
  if (process.env.PIXELSENTINEL_SHELL_APK) return process.env.PIXELSENTINEL_SHELL_APK;
  // packages/core/{src,dist}/runtime/android -> packages/android-shell/dist
  return fileURLToPath(new URL("../../../../android-shell/dist/pixelsentinel-shell.apk", import.meta.url));
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

export class AndroidRuntime implements DeviceRuntime {
  readonly name = "android";
  private fallbackBrowser = new BrowserSlot();
  private generation = 0;
  private assertGeneration(generation: number) { if (generation !== this.generation) throw new Error("Android runtime shut down during launch"); }
  private devices = new Map<string, AndroidDevice>();
  private locks = new Map<string, Promise<void>>();

  constructor(
    private readonly emulators: EmulatorManager = defaultEmulatorManager,
    private readonly adb: AdbClient = defaultAdbClient,
    private readonly log: (msg: string) => void = (m) => process.env.PIXELSENTINEL_DEBUG && console.error(`[android] ${m}`)
  ) {}

  async isAvailable(target?: DeviceTarget): Promise<DeviceAvailability> {
    const connected = target?.android ? await this.emulators.findRunning(target.android.avd) : null;
    if (!connected && !emulatorInstalled()) {
      return { available: false, reason: "Android emulator is not installed (run `pixelsentinel devices install`)" };
    }
    if (!connected && target?.android && !avdExists(target.android.avd)) {
      return {
        available: false,
        reason: `AVD '${target.android.avd}' missing (run \`pixelsentinel devices create ${target.android.profile}\`)`
      };
    }
    if (target?.android?.browser === "webview-shell" && !existsSync(webViewShellApkPath())) {
      return { available: false, reason: "WebView shell APK not built (run `pixelsentinel devices build-shell`)" };
    }
    return { available: true };
  }

  async launch(target: DeviceTarget): Promise<DeviceSession> {
    const generation = this.generation;
    if (process.env.PIXELSENTINEL_DEVICES === "approximate") {
      return this.launchFallback(target, "PIXELSENTINEL_DEVICES=approximate", generation);
    }
    const availability = await this.isAvailable(target);
    this.assertGeneration(generation);
    if (!target.android || !availability.available) {
      return this.launchFallback(target, availability.reason || "target has no Android emulator configuration", generation);
    }
    try {
      return await this.launchReal(target, generation);
    } catch (err) {
      this.assertGeneration(generation);
      if (process.env.PIXELSENTINEL_STRICT_DEVICES === "1") throw err;
      return this.launchFallback(target, `emulator launch failed: ${(err as Error).message.split("\n")[0]}`, generation);
    }
  }

  /** One session per emulator at a time; returns the release function. */
  private async lock(key: string): Promise<() => void> {
    while (this.locks.has(key)) await this.locks.get(key);
    let release!: () => void;
    this.locks.set(key, new Promise<void>((r) => (release = r)));
    return () => {
      this.locks.delete(key);
      release();
    };
  }

  private async getDevice(serial: string, generation: number): Promise<AndroidDevice> {
    const cached = this.devices.get(serial);
    if (cached) return cached;
    const all = await _android.devices({ omitDriverInstall: true });
    let found: AndroidDevice | undefined;
    for (const d of all) {
      if (d.serial() === serial && !found) found = d;
      else await d.close().catch(() => {});
    }
    if (!found) throw new Error(`Playwright could not attach to ${serial}`);
    if (generation !== this.generation) { await found.close(); this.assertGeneration(generation); }
    this.devices.set(serial, found);
    return found;
  }

  private async launchReal(target: DeviceTarget, generation: number): Promise<DeviceSession> {
    const cfg = target.android!;
    const release = await this.lock(cfg.avd);
    const cleanups: Array<() => Promise<unknown>> = [];
    try {
      this.assertGeneration(generation);
      const instance = await this.emulators.acquire(cfg.avd, { onLog: this.log });
      cleanups.push(async () => { this.emulators.releaseLease(instance); });
      this.assertGeneration(generation);
      const serial = instance.serial;
      const device = await this.getDevice(serial, generation);
      const rawSh = (cmd: string) => this.adb.shell(serial, cmd);
      const sh = (cmd: string) => { this.assertGeneration(generation); return rawSh(cmd); };
      const mods = target.modifiers ?? {};

      const [oldSize, oldDensity, oldRotation, oldAutoRotation, oldFont, oldNight, oldDebugApp] = await Promise.all([
        sh("wm size"), sh("wm density"), sh("settings get system user_rotation"), sh("settings get system accelerometer_rotation"),
        mods.fontScale ? sh("settings get system font_scale") : Promise.resolve(""),
        mods.darkMode !== undefined ? sh("cmd uimode night") : Promise.resolve(""),
        sh("settings get global debug_app")
      ]);
      cleanups.push(async () => {
        const restore = [
          `settings put system user_rotation ${Number(oldRotation.trim()) || 0}`,
          `settings put system accelerometer_rotation ${Number(oldAutoRotation.trim()) || 0}`
        ];
        if (cfg.display) restore.push(
          `wm size ${oldSize.match(/Override size:\s*(\d+x\d+)/)?.[1] ?? "reset"}`,
          `wm density ${oldDensity.match(/Override density:\s*(\d+)/)?.[1] ?? "reset"}`
        );
        if (mods.fontScale) restore.push(/^\d+(\.\d+)?$/.test(oldFont.trim()) ? `settings put system font_scale ${oldFont.trim()}` : "settings delete system font_scale");
        const night = oldNight.match(/Night mode:\s*(yes|no|auto|custom)/i)?.[1];
        if (mods.darkMode !== undefined && night) restore.push(`cmd uimode night ${night}`);
        const previousDebug = oldDebugApp.trim();
        restore.push(/^[a-zA-Z][\w.]+$/.test(previousDebug) && previousDebug !== "null"
          ? `am set-debug-app --persistent ${previousDebug}` : "am clear-debug-app");
        for (const command of restore) await rawSh(command).catch(() => {});
      });
      if (cfg.display) {
        await sh(`wm size ${cfg.display.width}x${cfg.display.height}`);
        await sh(`wm density ${cfg.display.density}`);
      }
      await sh("settings put system accelerometer_rotation 0");
      await sh("settings put system user_rotation 0");
      if (mods.fontScale) await sh(`settings put system font_scale ${mods.fontScale}`);
      if (mods.darkMode !== undefined) await sh(`cmd uimode night ${mods.darkMode ? "yes" : "no"}`);
      if (target.isFoldable) {
        await this.adb.emu(serial, mods.posture === "folded" ? "fold" : "unfold").catch(() => {});
        cleanups.push(() => this.adb.emu(serial, "unfold").catch(() => {}));
      }

      let context: BrowserContext | null = null;
      let page: Page;
      let fidelity: DeviceTarget["fidelity"];

      if (cfg.browser === "chrome") {
        if (!(await this.adb.isPackageInstalled(serial, CHROME_PACKAGE))) {
          throw new Error(`Chrome is not installed on ${cfg.avd}; use a google_apis_playstore system image`);
        }
        await sh(`am set-debug-app --persistent ${CHROME_PACKAGE}`);
        context = await device.launchBrowser({ viewport: null, hasTouch: !target.isTV });
        page = context.pages()[0] ?? (await context.newPage());
        fidelity = "real";
        cleanups.push(async () => {
          for (const p of context!.pages()) await p.close().catch(() => {});
          await context!.close().catch(() => {});
        });
        cleanups.push(() => rawSh(`am force-stop ${CHROME_PACKAGE}`));
      } else {
        // Reinstall with -r so rebuilding the shell cannot leave an older APK running.
        await this.adb.install(serial, webViewShellApkPath());
        await sh(`am force-stop ${SHELL_PACKAGE}`);
        cleanups.push(() => rawSh(`am force-stop ${SHELL_PACKAGE}`));
        await sh(`am start -W -n ${SHELL_PACKAGE}/.MainActivity -d about:blank --ez dpad ${cfg.input === "dpad" ? "true" : "false"}`);
        const webview = await device.webView({ pkg: SHELL_PACKAGE }, { timeout: 30000 });
        page = await webview.page();
        fidelity = "webview";
      }

      this.assertGeneration(generation);
      let currentTarget: DeviceTarget = { ...target, fidelity };
      const control = new AndroidDeviceControl(
        page,
        this.adb,
        serial,
        () => currentTarget,
        (next) => (currentTarget = next)
      );
      await control.rotate(mods.orientation ?? target.orientation ?? (target.viewport.width > target.viewport.height ? "landscape" : "portrait"));

      const reversed: number[] = [];
      let closed = false;
      return {
        id: `android-${crypto.randomUUID().slice(0, 8)}`,
        get target() {
          return currentTarget;
        },
        page,
        control,
        warnings: [],
        deviceInfo: { serial, avd: cfg.avd, bootMs: instance.bootMs, browser: cfg.browser },
        prepareUrl: async (url: string) => {
          const u = new URL(url);
          if (u.protocol === "file:") {
            throw new Error("file:// targets cannot be loaded on a device; serve them over http");
          }
          if (LOCAL_HOSTS.has(u.hostname)) {
            const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
            await this.adb.reversePort(serial, port, port);
            reversed.push(port);
            u.hostname = "127.0.0.1";
          }
          return u.toString();
        },
        close: async () => {
          if (closed) return;
          closed = true;
          for (const port of reversed) await this.adb.removeReverse(serial, port);
          for (const fn of cleanups.reverse()) await fn().catch(() => {});
          release();
        }
      };
    } catch (err) {
      for (const fn of cleanups.reverse()) await fn().catch(() => {});
      release();
      throw err;
    }
  }

  private async launchFallback(target: DeviceTarget, reason: string, generation: number): Promise<DeviceSession> {
    if (process.env.PIXELSENTINEL_STRICT_DEVICES === "1") throw new Error(`${target.id}: device unavailable: ${reason}; strict device mode forbids approximation`);
    this.assertGeneration(generation);
    const browser = await this.fallbackBrowser.get(() => chromium.launch({
      headless: true, args: ["--disable-animations", "--disable-dev-shm-usage", "--no-sandbox"]
    }));
    this.assertGeneration(generation);
    let viewport = { ...target.viewport };
    const o = target.modifiers?.orientation;
    if ((o === "landscape" && viewport.height > viewport.width) || (o === "portrait" && viewport.width > viewport.height)) {
      viewport = { width: viewport.height, height: viewport.width };
    }
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: target.deviceScaleFactor,
      isMobile: target.isMobile,
      hasTouch: target.hasTouch,
      colorScheme: target.modifiers?.darkMode ? "dark" : undefined,
      userAgent:
        target.userAgent ||
        "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
    });
    const page = await context.newPage();
    let currentTarget: DeviceTarget = { ...target, viewport, fidelity: "approximate" };
    const control = new PlaywrightControl(page, () => currentTarget, (n) => (currentTarget = n));
    return {
      id: `android-approx-${crypto.randomUUID().slice(0, 8)}`,
      get target() {
        return currentTarget;
      },
      page,
      control,
      warnings: [`${target.id}: ${reason}; rendered with approximate headless Chromium instead`],
      close: async () => {
        await context.close().catch(() => {});
      }
    };
  }

  async shutdown(): Promise<void> {
    this.generation++;
    for (const d of this.devices.values()) await d.close().catch(() => {});
    this.devices.clear();
    await this.fallbackBrowser.close();
    if (process.env.PIXELSENTINEL_KEEP_EMULATORS !== "1") {
      await this.emulators.shutdownAll();
    } else await this.emulators.cancelPendingBoots();
  }
}

import crypto from "node:crypto";
import { chromium, firefox, type Browser, type BrowserContext, type Page } from "playwright";
import { PlaywrightControl } from "./playwright.js";
import { BrowserSlot } from "./browser-slot.js";
import type {
  DeviceAvailability,
  DeviceRuntime,
  DeviceSession,
  DeviceTarget
} from "./types.js";
import { WindowsVm, readWindowsVmConfig } from "./windows/vm.js";

export { PlaywrightControl as WindowsControl };
export * from "./windows/vm.js";

/**
 * Real Windows rendering via `playwright run-server` running inside a Windows host:
 *  - PIXELSENTINEL_WINDOWS_ENDPOINT=ws://host:3100/  (any Windows machine / CI runner), or
 *  - the local QEMU/KVM VM created with `pixelsentinel devices windows init`.
 * Without either, falls back to approximate Linux Chromium and records a warning.
 */
export class WindowsRuntime implements DeviceRuntime {
  readonly name = "windows";
  private endpoint: string | null =
    process.env.PIXELSENTINEL_WINDOWS_ENDPOINT || process.env.PIXELSENTINEL_WINDOWS_CDP_URL || null;
  private vm: WindowsVm | null = null;
  private remoteBrowsers = new Map<string, BrowserSlot>();
  private fallbackBrowser = new BrowserSlot();
  private generation = 0;
  private assertGeneration(generation: number) { if (generation !== this.generation) throw new Error("Windows runtime shut down during launch"); }

  setRemoteUrl(url: string | null): void {
    this.endpoint = url;
  }

  private async resolveEndpoint(generation: number): Promise<string | null> {
    if (this.endpoint) return this.endpoint;
    const cfg = readWindowsVmConfig();
    if (!cfg?.provisioned) return null;
    const vm = this.vm = new WindowsVm(cfg);
    const endpoint = await vm.start();
    if (generation !== this.generation) { await vm.stop(); this.assertGeneration(generation); }
    this.endpoint = endpoint;
    return this.endpoint;
  }

  async isAvailable(): Promise<DeviceAvailability> {
    if (this.endpoint) return { available: true, details: { endpoint: this.endpoint } };
    const cfg = readWindowsVmConfig();
    if (cfg?.provisioned) return { available: true, details: { vm: true } };
    return {
      available: false,
      reason:
        "No Windows host configured (set PIXELSENTINEL_WINDOWS_ENDPOINT or run `pixelsentinel devices windows init --iso <win11.iso>`)"
    };
  }

  private async remoteBrowser(endpoint: string, target: DeviceTarget): Promise<Browser> {
    const browserName = target.windows?.browser ?? "msedge";
    let slot = this.remoteBrowsers.get(browserName);
    if (!slot) { slot = new BrowserSlot(); this.remoteBrowsers.set(browserName, slot); }
    const type = browserName === "firefox" ? firefox : chromium;
    const launchOptions = browserName === "firefox" ? {} : { channel: browserName };
    return slot.get(() => type.connect(endpoint, {
      timeout: 60000, headers: { "x-playwright-launch-options": JSON.stringify(launchOptions) }
    }));
  }

  async launch(target: DeviceTarget): Promise<DeviceSession> {
    const generation = this.generation;
    const warnings: string[] = [];
    let browser: Browser | null = null;
    let fidelity: DeviceTarget["fidelity"] = "approximate";

    try {
      const endpoint = await this.resolveEndpoint(generation);
      this.assertGeneration(generation);
      if (endpoint) {
        browser = await this.remoteBrowser(endpoint, target);
        fidelity = "real";
      } else {
        warnings.push(`${target.id}: no Windows host configured; rendered with approximate Linux Chromium`);
      }
    } catch (err) {
      this.assertGeneration(generation);
      if (process.env.PIXELSENTINEL_STRICT_DEVICES === "1") throw err;
      warnings.push(`${target.id}: Windows host unreachable (${(err as Error).message.split("\n")[0]}); rendered with approximate Linux Chromium`);
    }

    this.assertGeneration(generation);
    if (!browser) browser = await this.fallbackBrowser.get(() => chromium.launch({
      headless: true, args: ["--disable-animations", "--disable-dev-shm-usage", "--no-sandbox"]
    }));
    this.assertGeneration(generation);

    const context: BrowserContext = await browser.newContext({
      viewport: target.viewport,
      deviceScaleFactor: target.windows?.scale ?? target.deviceScaleFactor,
      isMobile: false,
      hasTouch: false,
      // On a real Windows host keep the browser's genuine UA
      userAgent: fidelity === "real" ? undefined : target.userAgent,
      colorScheme: target.modifiers?.darkMode ? "dark" : undefined
    });
    const page: Page = await context.newPage();
    let currentTarget: DeviceTarget = { ...target, fidelity };
    const control = new PlaywrightControl(page, () => currentTarget, (n) => (currentTarget = n));

    return {
      id: `win-${crypto.randomUUID().slice(0, 8)}`,
      get target() {
        return currentTarget;
      },
      page,
      control,
      warnings,
      deviceInfo: fidelity === "real" ? { endpoint: this.endpoint, browser: target.windows?.browser } : undefined,
      prepareUrl: async (url: string) => {
        // The guest reaches the host's localhost via QEMU user-net gateway 10.0.2.2
        if (fidelity !== "real" || !this.vm) return url;
        const u = new URL(url);
        if (["localhost", "127.0.0.1", "0.0.0.0"].includes(u.hostname)) u.hostname = "10.0.2.2";
        return u.toString();
      },
      close: async () => {
        await context.close().catch(() => {});
      }
    };
  }

  async shutdown(): Promise<void> {
    this.generation++;
    const slots = [...this.remoteBrowsers.values()]; this.remoteBrowsers.clear();
    await Promise.all([...slots.map((slot) => slot.close()), this.fallbackBrowser.close()]);
    if (this.vm && process.env.PIXELSENTINEL_KEEP_WINDOWS_VM !== "1") {
      await this.vm.stop().catch(() => {});
      this.vm = null;
      this.endpoint = process.env.PIXELSENTINEL_WINDOWS_ENDPOINT || null;
    }
  }
}

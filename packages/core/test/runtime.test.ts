import { afterAll, describe, expect, it, vi } from "vitest";
import { AndroidRuntime } from "../src/runtime/android/runtime.js";
import { PlaywrightRuntime } from "../src/runtime/playwright.js";
import { BUILTIN_DEVICES, globalDeviceRegistry, parseDeviceId } from "../src/runtime/registry.js";
import { WindowsRuntime } from "../src/runtime/windows.js";

describe("Device Runtime Provider Abstraction", () => {
  afterAll(() => {
    delete process.env.PIXELSENTINEL_DEVICES;
  });

  it("resolves built-in devices and maps viewports to DeviceTarget", () => {
    const pixel8 = globalDeviceRegistry.resolveTarget("android:pixel-8");
    expect(pixel8.name).toBe("Google Pixel 8");
    expect(pixel8.runtime).toBe("android");
    expect(pixel8.viewport.width).toBe(412);
    expect(pixel8.android?.browser).toBe("chrome");

    const iphone = globalDeviceRegistry.resolveTarget("webkit:iphone-15-pro");
    expect(iphone.name).toBe("iPhone 15 Pro (WebKit)");
    expect(iphone.runtime).toBe("playwright");
    expect(iphone.engine).toBe("webkit");

    const customVp = globalDeviceRegistry.resolveTarget({
      name: "Custom Viewport",
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      orientation: "landscape"
    });
    expect(customVp.id).toBe("viewport:custom-viewport");
    expect(customVp.runtime).toBe("playwright");
    const foldViewport = globalDeviceRegistry.resolveTarget({ name: "Fold viewport", width: 841, height: 701,
      deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, orientation: "landscape", deviceDescriptor: "android:pixel-fold" });
    expect(foldViewport).toMatchObject({ runtime: "playwright", engine: "chromium", fidelity: "approximate", isFoldable: true,
      hingeRect: BUILTIN_DEVICES["android:pixel-fold"].hingeRect });
  });

  it("covers every Android form factor", () => {
    const ids = Object.keys(BUILTIN_DEVICES);
    for (const id of ["android:pixel-tablet", "android:pixel-fold", "android:tv-1080p", "android:tv-4k", "android:wear-round", "android:automotive"]) {
      expect(ids).toContain(id);
    }
    expect(BUILTIN_DEVICES["android:tv-1080p"].android?.browser).toBe("webview-shell");
  });

  it("parses device modifiers (orientation, posture, font scale, dark mode)", () => {
    expect(parseDeviceId("android:pixel-fold@folded@landscape@font1.3@dark")).toEqual({
      baseId: "android:pixel-fold",
      modifiers: { posture: "folded", orientation: "landscape", fontScale: 1.3, darkMode: true }
    });
    const folded = globalDeviceRegistry.resolveTarget("android:pixel-fold@folded");
    expect(folded.id).toBe("android:pixel-fold@folded");
    expect(folded.hingeRect).toBeUndefined();
    expect(() => parseDeviceId("android:pixel-8@sideways")).toThrow(/Unknown device modifier/);
  });

  it("launches a Playwright WebKit device session and executes controls", async () => {
    const runtime = new PlaywrightRuntime();
    const target = BUILTIN_DEVICES["webkit:iphone-15-pro"];

    const session = await runtime.launch(target);
    expect(session.id).toBeDefined();
    expect(session.target.id).toBe("webkit:iphone-15-pro");
    expect(session.page).toBeDefined();
    expect(session.warnings).toEqual([]);

    await session.page.setContent("<html><body><button id='btn'>Click</button></body></html>");
    await session.control.scroll("down", 100);
    await session.control.setKeyboardVisible(true);
    await session.control.setKeyboardVisible(false);

    const screenshot = await session.control.captureScreenshot();
    expect(screenshot).toBeInstanceOf(Buffer);
    expect(screenshot.length).toBeGreaterThan(0);

    await session.close();
    await runtime.shutdown();
  }, 30000);

  it("applies orientation modifier on Playwright targets", async () => {
    const runtime = new PlaywrightRuntime();
    const session = await runtime.launch(globalDeviceRegistry.resolveTarget("chromium:desktop-1080p@portrait"));
    expect(session.page.viewportSize()).toEqual({ width: 1080, height: 1920 });
    await session.close();
    await runtime.shutdown();
  }, 30000);

  it("falls back to approximate Chromium with an explicit warning when no emulator is used", async () => {
    process.env.PIXELSENTINEL_DEVICES = "approximate";
    const runtime = new AndroidRuntime();
    const session = await runtime.launch(BUILTIN_DEVICES["android:pixel-8"]);
    expect(session.target.fidelity).toBe("approximate");
    expect(session.warnings[0]).toMatch(/approximate headless Chromium/);
    await session.close();
    await runtime.shutdown();
  }, 30000);

  it("rejects unavailable devices in strict mode instead of silently using Chromium", async () => {
    vi.stubEnv("ANDROID_HOME", "/missing-pixelsentinel-sdk");
    vi.stubEnv("ANDROID_AVD_HOME", "/missing-pixelsentinel-avds");
    vi.stubEnv("PIXELSENTINEL_DEVICES", "");
    vi.stubEnv("PIXELSENTINEL_STRICT_DEVICES", "1");
    const runtime = new AndroidRuntime();
    const target = { ...BUILTIN_DEVICES["android:pixel-8"], android: { ...BUILTIN_DEVICES["android:pixel-8"].android!, avd: "ps-test-unavailable" } };
    try { await expect(runtime.launch(target)).rejects.toThrow(/not installed|missing|unavailable/); }
    finally { await runtime.shutdown(); vi.unstubAllEnvs(); }
  });

  it("reports Windows as unavailable without a Windows host and falls back with a warning", async () => {
    const prev = process.env.PIXELSENTINEL_WINDOWS_ENDPOINT;
    delete process.env.PIXELSENTINEL_WINDOWS_ENDPOINT;
    process.env.PIXELSENTINEL_WINDOWS_VM_DIR = "/nonexistent-pixelsentinel-vm";
    const windowsRuntime = new WindowsRuntime();
    const avail = await windowsRuntime.isAvailable();
    expect(avail.available).toBe(false);
    const session = await windowsRuntime.launch(BUILTIN_DEVICES["windows:msedge-1080p"]);
    expect(session.target.fidelity).toBe("approximate");
    expect(session.warnings.join(" ")).toMatch(/no Windows host configured/);
    await session.close();
    await windowsRuntime.shutdown();
    delete process.env.PIXELSENTINEL_WINDOWS_VM_DIR;
    if (prev) process.env.PIXELSENTINEL_WINDOWS_ENDPOINT = prev;
  }, 30000);
});

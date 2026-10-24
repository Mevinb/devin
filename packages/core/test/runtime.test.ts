import { describe, expect, it } from "vitest";
import { AndroidRuntime } from "../src/runtime/android.js";
import { PlaywrightRuntime } from "../src/runtime/playwright.js";
import { BUILTIN_DEVICES, globalDeviceRegistry } from "../src/runtime/registry.js";
import { WindowsRuntime } from "../src/runtime/windows.js";

describe("Device Runtime Provider Abstraction", () => {
  it("resolves built-in devices and maps viewports to DeviceTarget", () => {
    const pixel8 = globalDeviceRegistry.resolveTarget("android:pixel-8");
    expect(pixel8.name).toBe("Google Pixel 8");
    expect(pixel8.runtime).toBe("android");
    expect(pixel8.viewport.width).toBe(412);

    const iphone = globalDeviceRegistry.resolveTarget("webkit:iphone-15-pro");
    expect(iphone.name).toBe("iPhone 15 Pro (WebKit)");
    expect(iphone.runtime).toBe("playwright");

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
  });

  it("launches a Playwright WebKit device session and executes controls", async () => {
    const runtime = new PlaywrightRuntime();
    const target = BUILTIN_DEVICES["webkit:iphone-15-pro"];

    const session = await runtime.launch(target);
    expect(session.id).toBeDefined();
    expect(session.target.id).toBe("webkit:iphone-15-pro");
    expect(session.page).toBeDefined();

    // Verify control methods
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

  it("checks availability for Android and Windows runtimes", async () => {
    const androidRuntime = new AndroidRuntime();
    const androidAvail = await androidRuntime.isAvailable();
    expect(androidAvail).toHaveProperty("available");

    const windowsRuntime = new WindowsRuntime();
    const windowsAvail = await windowsRuntime.isAvailable();
    expect(windowsAvail.available).toBe(true); // local simulation available
  });
});

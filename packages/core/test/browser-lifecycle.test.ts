import { chromium, webkit } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import { CaptureRunner } from "../src/capture/runner.js";
import { PlaywrightRuntime } from "../src/runtime/playwright.js";
import { AndroidRuntime } from "../src/runtime/android/runtime.js";
import { WindowsRuntime } from "../src/runtime/windows.js";
import { BUILTIN_DEVICES } from "../src/runtime/registry.js";
import { ScanConfigSchema } from "../src/config/schema.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(["legacy", "chromium", "webkit", "android-fallback", "windows-fallback"])("closes a late %s browser and creates no context after shutdown", async (kind) => {
  const type = kind === "webkit" ? webkit : chromium;
  const browser = await type.launch();
  const context = vi.spyOn(browser, "newContext"), closed = vi.spyOn(browser, "close");
  let finish!: (browser: typeof browser) => void;
  const delayed = new Promise<typeof browser>((resolve) => { finish = resolve; });
  const launch = vi.spyOn(type, "launch").mockReturnValueOnce(delayed);
  let pending: Promise<unknown>, shutdown: () => Promise<void>;
  if (kind === "legacy") {
    const runner = new CaptureRunner(), config = ScanConfigSchema.parse({ target: "https://fixture.invalid" });
    pending = runner.captureOne("https://fixture.invalid", { name: "Late", renderId: "late", width: 400, height: 300, deviceScaleFactor: 1, isMobile: false, hasTouch: false, orientation: "landscape" }, config, "/tmp/ps-late-capture");
    shutdown = () => runner.close();
  } else if (kind === "android-fallback") {
    vi.stubEnv("PIXELSENTINEL_DEVICES", "approximate"); vi.stubEnv("PIXELSENTINEL_STRICT_DEVICES", "");
    const runtime = new AndroidRuntime(); pending = runtime.launch(BUILTIN_DEVICES["android:pixel-8"]); shutdown = () => runtime.shutdown();
  } else if (kind === "windows-fallback") {
    vi.stubEnv("PIXELSENTINEL_STRICT_DEVICES", "");
    const runtime = new WindowsRuntime();
    vi.spyOn(runtime as unknown as { resolveEndpoint: () => Promise<null> }, "resolveEndpoint").mockResolvedValue(null);
    pending = runtime.launch(BUILTIN_DEVICES["windows:msedge-1080p"]); shutdown = () => runtime.shutdown();
  } else {
    const runtime = new PlaywrightRuntime(); pending = runtime.launch(BUILTIN_DEVICES[kind === "webkit" ? "webkit:iphone-15-pro" : "chromium:desktop-1080p"]); shutdown = () => runtime.shutdown();
  }
  const rejected = expect(pending).rejects.toThrow(/shut down|closed/);
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  await shutdown(); finish(browser); await rejected;
  expect(closed).toHaveBeenCalledOnce(); expect(context).not.toHaveBeenCalled(); expect(browser.isConnected()).toBe(false);
});

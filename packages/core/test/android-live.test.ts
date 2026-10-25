import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright";
import { createServer } from "../../server/src/index.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scan } from "../src/scanner.js";
import { defaultAdbClient } from "../src/runtime/android/adb.js";
import { BUILTIN_DEVICES } from "../src/runtime/registry.js";
import { EmulatorManager } from "../src/runtime/android/emulator.js";
import { AndroidRuntime } from "../src/runtime/android/runtime.js";
import { startStaticServer } from "../src/target/static-server.js";
import type { DeviceTarget } from "../src/runtime/types.js";

const live = process.env.PIXELSENTINEL_RUN_ANDROID_LIVE === "1";
const output = path.resolve(process.env.PIXELSENTINEL_ANDROID_TEST_OUT ?? "pixelsentinel-output/android-live");
describe.runIf(live)("Real Android Chrome capture (requires a connected ps_phone emulator or KVM)", () => {
  beforeAll(() => { vi.stubEnv("PIXELSENTINEL_STRICT_DEVICES", "1"); vi.stubEnv("PIXELSENTINEL_DEVICES", ""); });
  afterAll(() => { vi.unstubAllEnvs(); });

  it("scans portrait and landscape on real Chrome, emits device frames, and restores rotation", async () => {
    const borrowed = await new EmulatorManager().findRunning("ps_phone");
    const before = borrowed ? await defaultAdbClient.shell(borrowed, "settings get system user_rotation") : "";
    const report = await scan({ target: path.resolve(__dirname, "../../../fixtures/overlap"),
      devices: ["android:pixel-8@portrait", "android:pixel-8@landscape"], concurrency: 2, extraWaitMs: 200,
      vision: { enabled: false }, output: { dir: path.join(output, "orientation") } });
    expect(report.errors).toBeUndefined(); expect(report.matrix).toHaveLength(2);
    for (const item of report.matrix) {
      expect(item.device?.fidelity).toBe("real"); expect(item.device?.browser).toBe("chrome");
      expect(item.findings.length).toBeGreaterThan(0); expect(item.deviceScreenshotRelPath).toBeTruthy();
      const frame = await sharp(path.join(output, "orientation", item.deviceScreenshotRelPath!)).metadata();
      expect(Math.max(frame.width!, frame.height!)).toBeGreaterThanOrEqual(2000);
      if (item.renderId.includes("landscape")) expect(frame.width).toBeGreaterThan(frame.height!);
      else expect(frame.height).toBeGreaterThan(frame.width!);
    }
    const serial = report.matrix[0].device!.info!.serial as string;
    if (borrowed && before) {
      expect(await defaultAdbClient.shell(serial, "settings get system user_rotation")).toBe(before);
      expect(await defaultAdbClient.isBootCompleted(serial)).toBe(true); // borrowed emulator must remain running
    } else expect((await defaultAdbClient.listDevices()).some((device) => device.serial === serial && device.state === "device")).toBe(false);
  }, 120000);

  it("opens the real soft keyboard and records measured viewport and device screenshot evidence", async () => {
    const report = await scan({ target: path.resolve(__dirname, "../../../fixtures/device/keyboard.html"),
      devices: [BUILTIN_DEVICES["android:pixel-8"]], vision: { enabled: false }, extraWaitMs: 300,
      output: { dir: path.join(output, "keyboard") } });
    expect(report.errors).toBeUndefined(); expect(report.matrix).toHaveLength(1);
    expect(report.matrix[0].device?.fidelity).toBe("real");
    const probe = report.matrix[0].keyboardProbes?.find((item) => item.selector.includes("chatInput"));
    expect(probe, "The real input should be probed").toBeDefined();
    expect(probe!.keyboardShown).toBe(true);
    expect(probe!.screenshotPath).toBeTruthy(); await fs.access(probe!.screenshotPath!);
  }, 120000);
  it("shows a real device-frame screenshot through the dashboard inspector", async () => {
    const server = createServer({ outputDir: path.join(output, "dashboard"), logger: false });
    const browser = await chromium.launch({ headless: true });
    try {
      const url = await server.listen({ port: 0, host: "127.0.0.1" });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.getByLabel("Scan target", { exact: true }).fill(path.resolve(__dirname, "../../../fixtures/overlap"));
      await page.getByLabel("Device IDs", { exact: true }).fill("android:pixel-8");
      await page.getByLabel("OpenAI vision", { exact: true }).uncheck();
      await page.getByRole("button", { name: "Run scan", exact: true }).click();
      await page.getByRole("region", { name: "Scan results", exact: true }).waitFor({ timeout: 60000 });
      expect(await page.locator(".device-fidelity").textContent()).toBe("real");
      await page.locator(".device-card").click();
      const dialog = page.getByRole("dialog", { name: /Inspector:/ });
      await dialog.getByRole("button", { name: "Device frame", exact: true }).click();
      const frame = dialog.getByRole("img", { name: /^Device frame:/ });
      await vi.waitFor(async () => expect(await frame.evaluate((image) => (image as HTMLImageElement).naturalHeight)).toBeGreaterThan(2000), { timeout: 5000 });
      expect(await frame.getAttribute("src")).toContain("device.png");
      await fs.mkdir("/tmp/pixelsentinel-qa", { recursive: true });
      await page.screenshot({ path: "/tmp/pixelsentinel-qa/real-android-frame.png" });
      await dialog.getByRole("button", { name: "Annotated page", exact: true }).click();
      expect(await dialog.getByRole("img", { name: /^Annotated page:/ }).getAttribute("src")).toContain("annotated.png");
      expect(errors).toEqual([]);
    } finally { await browser.close(); await server.close(); }
  }, 90000);

  it.runIf(process.env.PIXELSENTINEL_RUN_SHELL_LIVE === "1")("scans through the built WebView shell and sends real D-pad keys on the connected phone", async () => {
    // This proves the APK/CDP/input path on a phone. It does not claim TV/Wear/Auto validation.
    const phone = BUILTIN_DEVICES["android:pixel-8"];
    const shell: DeviceTarget = { ...phone, id: "android:phone-shell-test", name: "Phone WebView shell test",
      android: { ...phone.android!, browser: "webview-shell" } };
    const report = await scan({ target: path.resolve(__dirname, "../../../fixtures/overlap"), devices: [shell],
      vision: { enabled: false }, extraWaitMs: 300, output: { dir: path.join(output, "shell") } });
    expect(report.errors).toBeUndefined(); expect(report.matrix).toHaveLength(1);
    expect(report.matrix[0].device?.fidelity).toBe("webview");
    expect(report.matrix[0].device?.browser).toBe("webview-shell");
    expect(report.matrix[0].findings.some((finding) => finding.type === "element-overlap")).toBe(true);
    const deviceImage = report.matrix[0].deviceScreenshotRelPath!;
    expect((await sharp(path.join(output, "shell", deviceImage)).metadata()).height).toBeGreaterThan(2000);

    const server = await startStaticServer(path.resolve(__dirname, "../../../fixtures/device/focus-ring.html"));
    const runtime = new AndroidRuntime();
    try {
      const session = await runtime.launch({ ...shell, orientation: "landscape", isTV: true,
        android: { ...shell.android!, input: "dpad" } });
      try {
        await session.page.goto(await session.prepareUrl!(server.url));
        await session.page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__pixelSentinelDpad));
        await session.page.evaluate(() => {
          document.querySelector<HTMLButtonElement>("#btnPlay")!.focus();
          document.querySelector("#btnSettings")!.addEventListener("click", () => { document.body.dataset.clicked = "settings"; });
        });
        await session.control.pressKey("ArrowRight");
        await vi.waitFor(async () => expect(await session.page.evaluate(() => document.activeElement?.id)).toBe("btnSettings"));
        await session.control.pressKey("Enter");
        await vi.waitFor(async () => expect(await session.page.locator("body").getAttribute("data-clicked")).toBe("settings"));
        const frame = await session.control.deviceScreenshot!(); expect(frame).not.toBeNull();
        await fs.writeFile(path.join(output, "shell/dpad-device.png"), frame!);
      } finally { await session.close(); }
    } finally { await runtime.shutdown(); await server.cleanup(); }
  }, 120000);

});

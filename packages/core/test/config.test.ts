import { describe, expect, it } from "vitest";
import { expandMatrix, DEFAULT_VIEWPORTS } from "../src/config/index.js";
import { ScanConfigSchema } from "../src/config/schema.js";

describe("Config & Matrix Expansion", () => {
  it("validates valid ScanConfig", () => {
    const parsed = ScanConfigSchema.parse({
      target: "https://example.com"
    });
    expect(parsed.target).toBe("https://example.com");
    expect(parsed.browser).toBe("chromium");
    expect(parsed.concurrency).toBe(4);
    expect(parsed.vision.enabled).toBe(true);
  });

  it("expands default matrix into deterministic render IDs", () => {
    const config = ScanConfigSchema.parse({ target: "https://example.com" });
    const renders = expandMatrix(config);

    expect(renders.length).toBe(DEFAULT_VIEWPORTS.length);
    expect(renders[0].renderId).toBeDefined();

    const fhd = renders.find((r) => r.name === "desktop-fhd");
    expect(fhd).toBeDefined();
    expect(fhd?.width).toBe(1920);
    expect(fhd?.height).toBe(1080);
    expect(fhd?.renderId).toContain("1920x1080");
  });

  it("handles custom viewports correctly", () => {
    const config = ScanConfigSchema.parse({
      target: "https://example.com",
      viewports: [
        {
          name: "custom-mobile",
          width: 375,
          height: 667,
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          orientation: "portrait"
        }
      ]
    });

    const renders = expandMatrix(config);
    expect(renders.length).toBe(1);
    expect(renders[0].renderId).toBe("custom-mobile_375x667@2x_portrait");
  });

  it("preserves custom runtime settings and modifiers through configuration validation", () => {
    const device = {
      id: "custom:tablet", name: "Custom tablet", runtime: "android", engine: "chromium",
      viewport: { width: 800, height: 600 }, fidelity: "webview",
      android: { avd: "test-tablet", profile: "tablet", browser: "webview-shell", input: "dpad" },
      modifiers: { orientation: "landscape", fontScale: 1.3, darkMode: true }, isAutomotive: true
    };
    const config = ScanConfigSchema.parse({ target: ".", devices: [device], devServer: { port: 0 } });
    expect(config.devices?.[0]).toMatchObject(device);
    expect(config.devServer?.port).toBe(0);
  });
});

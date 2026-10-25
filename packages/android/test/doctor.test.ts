import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDevicesDoctor } from "../src/doctor.js";
import { getAvdProfile, listAvdProfiles } from "../src/profiles.js";

describe("Android Fleet Management and Diagnostics", () => {
  it("runs device runtime doctor and inspects system capabilities", async () => {
    const report = await runDevicesDoctor();

    expect(report.checks.length).toBeGreaterThanOrEqual(4);
    expect(report.timestamp).toBeDefined();

    const kvmCheck = report.checks.find((c) => c.name.includes("KVM"));
    expect(kvmCheck).toBeDefined();

    const javaCheck = report.checks.find((c) => c.name.includes("Java"));
    expect(javaCheck).toBeDefined();
    expect(javaCheck?.status).toBe("ok");

    const adbCheck = report.checks.find((c) => c.name.includes("ADB"));
    expect(adbCheck).toBeDefined();
    expect(adbCheck?.status).toBe("ok");
  });

  it("does not claim emulation readiness with a missing SDK and missing AVDs", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ps-doctor-empty-"));
    vi.stubEnv("ANDROID_HOME", path.join(temporary, "missing-sdk"));
    vi.stubEnv("ANDROID_AVD_HOME", path.join(temporary, "missing-avds"));
    try {
      const report = await runDevicesDoctor();
      expect(report.canEmulate).toBe(false);
      expect(report.checks.some((check) => check.category === "android-sdk" && check.status === "error")).toBe(true);
    } finally { vi.unstubAllEnvs(); await fs.rm(temporary, { recursive: true, force: true }); }
  });

  it("lists standard AVD profiles for mobile, foldable, tablet, and TV", () => {
    const profiles = listAvdProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(5);

    const pixel8 = getAvdProfile("pixel_8");
    expect(pixel8?.resolution.width).toBe(1080);
    expect(pixel8?.ramMb).toBe(4096);

    const fold = getAvdProfile("pixel_fold");
    expect(fold?.deviceType).toBe("foldable");

    const tv = getAvdProfile("android_tv_1080p");
    expect(tv?.deviceType).toBe("tv");
  });
});

import { describe, expect, it } from "vitest";
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

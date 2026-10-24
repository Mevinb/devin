import { exec } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  name: string;
  category: "virtualization" | "java" | "android-sdk" | "system";
  status: CheckStatus;
  message: string;
  details?: string;
  recommendation?: string;
}

export interface DoctorReport {
  timestamp: string;
  checks: DoctorCheck[];
  allPassed: boolean;
  canEmulate: boolean;
}

export async function runDevicesDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Check KVM Virtualization
  try {
    await fs.access("/dev/kvm");
    checks.push({
      name: "Hardware Virtualization (KVM)",
      category: "virtualization",
      status: "ok",
      message: "/dev/kvm is accessible. Hardware acceleration enabled."
    });
  } catch {
    checks.push({
      name: "Hardware Virtualization (KVM)",
      category: "virtualization",
      status: "warning",
      message: "/dev/kvm not found or insufficient permissions.",
      recommendation:
        "Enable VT-x/AMD-V in BIOS and run `sudo usermod -aG kvm $USER`. Headless SwiftShader software GPU can still be used."
    });
  }

  // 2. Check Java / JDK 17+
  try {
    const { stdout, stderr } = await execAsync("java -version");
    const output = stderr || stdout;
    const match = output.match(/version "([^"]+)"/) || output.match(/openjdk ([^\s]+)/);
    const verStr = match ? match[1] : "unknown";
    const major = parseInt(verStr.split(".")[0], 10);

    if (major >= 17) {
      checks.push({
        name: "Java Development Kit (JDK)",
        category: "java",
        status: "ok",
        message: `OpenJDK ${verStr} detected (meets requirement >= 17).`
      });
    } else {
      checks.push({
        name: "Java Development Kit (JDK)",
        category: "java",
        status: "warning",
        message: `Java version ${verStr} detected, but Android tools recommend JDK 17+.`,
        recommendation: "Install OpenJDK 17: `sudo apt install openjdk-17-jdk`."
      });
    }
  } catch {
    checks.push({
      name: "Java Development Kit (JDK)",
      category: "java",
      status: "error",
      message: "Java executable not found in PATH.",
      recommendation: "Install OpenJDK 17: `sudo apt install openjdk-17-jdk`."
    });
  }

  // 3. Check ADB
  try {
    const { stdout } = await execAsync("adb version");
    const firstLine = stdout.split("\n")[0];
    checks.push({
      name: "Android Debug Bridge (ADB)",
      category: "android-sdk",
      status: "ok",
      message: `${firstLine} installed and available.`
    });
  } catch {
    checks.push({
      name: "Android Debug Bridge (ADB)",
      category: "android-sdk",
      status: "warning",
      message: "ADB binary not found in PATH.",
      recommendation: "Install adb via `sudo apt install adb` or through Android SDK platform-tools."
    });
  }

  // 4. Check ANDROID_HOME / SDK Root
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (androidHome) {
    try {
      await fs.access(androidHome);
      checks.push({
        name: "Android SDK Root (ANDROID_HOME)",
        category: "android-sdk",
        status: "ok",
        message: `ANDROID_HOME configured at ${androidHome}`
      });
    } catch {
      checks.push({
        name: "Android SDK Root (ANDROID_HOME)",
        category: "android-sdk",
        status: "warning",
        message: `ANDROID_HOME set to ${androidHome} but directory does not exist.`,
        recommendation: "Ensure directory exists or re-run `pixelsentinel devices bootstrap`."
      });
    }
  } else {
    checks.push({
      name: "Android SDK Root (ANDROID_HOME)",
      category: "android-sdk",
      status: "warning",
      message: "ANDROID_HOME or ANDROID_SDK_ROOT is not set.",
      recommendation: "Set `export ANDROID_HOME=$HOME/Android/Sdk` in your shell profile."
    });
  }

  // 5. Check System RAM (>8GB recommended)
  const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const freeMemGB = Math.round(os.freemem() / (1024 * 1024 * 1024));
  if (totalMemGB >= 8) {
    checks.push({
      name: "System Memory (RAM)",
      category: "system",
      status: "ok",
      message: `${totalMemGB} GB total RAM (${freeMemGB} GB free). Meets >= 8GB requirement for emulator pooling.`
    });
  } else {
    checks.push({
      name: "System Memory (RAM)",
      category: "system",
      status: "warning",
      message: `${totalMemGB} GB total RAM is below 8GB. Emulators may run slowly or encounter memory pressure.`,
      recommendation: "Consider running a single emulator at a time or increasing swap space."
    });
  }

  const allPassed = checks.every((c) => c.status === "ok");
  const canEmulate = checks.filter((c) => c.status === "error").length === 0;

  return {
    timestamp: new Date().toISOString(),
    checks,
    allPassed,
    canEmulate
  };
}

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { defaultAdbClient, type AdbClient } from "./adb.js";

export interface RunningEmulator {
  avdName: string;
  serial: string;
  process: ChildProcess;
  cdpPort: number;
}

export class EmulatorPool {
  private activeEmulators: Map<string, RunningEmulator> = new Map();
  private adb: AdbClient;

  constructor(adbClient: AdbClient = defaultAdbClient) {
    this.adb = adbClient;
  }

  private getEmulatorBinary(): string {
    const androidHome =
      process.env.ANDROID_HOME ||
      process.env.ANDROID_SDK_ROOT ||
      path.join(process.env.HOME || "", "Android/Sdk");
    return path.join(androidHome, "emulator/emulator");
  }

  async acquire(avdName: string, timeoutMs = 60000): Promise<RunningEmulator> {
    const existing = this.activeEmulators.get(avdName);
    if (existing) {
      return existing;
    }

    // Check if an emulator with this AVD is already running via ADB
    const devicesBefore = await this.adb.listDevices();
    const binary = this.getEmulatorBinary();

    const args = [
      "-avd",
      avdName,
      "-no-window",
      "-gpu",
      "swiftshader_indirect",
      "-no-audio",
      "-no-boot-anim"
    ];

    const child = spawn(binary, args, {
      detached: true,
      stdio: "ignore"
    });

    // Poll ADB until a new emulator appears and boots
    const startTime = Date.now();
    let serial: string | null = null;

    while (Date.now() - startTime < timeoutMs) {
      const currentDevices = await this.adb.listDevices();
      const newDev = currentDevices.find(
        (d) =>
          d.serial.startsWith("emulator-") &&
          !devicesBefore.some((before) => before.serial === d.serial)
      );

      if (newDev) {
        serial = newDev.serial;
        const booted = await this.adb.isBootCompleted(serial);
        if (booted) {
          break;
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!serial) {
      child.kill("SIGKILL");
      throw new Error(`Emulator '${avdName}' failed to boot within ${timeoutMs / 1000} seconds.`);
    }

    // Forward CDP port
    const cdpPort = 9222 + this.activeEmulators.size;
    await this.adb.forwardPort(serial, cdpPort, "localabstract:chrome_devtools_remote");

    const instance: RunningEmulator = {
      avdName,
      serial,
      process: child,
      cdpPort
    };

    this.activeEmulators.set(avdName, instance);
    return instance;
  }

  async release(instance: RunningEmulator): Promise<void> {
    try {
      await this.adb.shell(instance.serial, "reboot -p");
    } catch {
      // Force kill if graceful shutdown fails
      instance.process.kill("SIGKILL");
    }
    this.activeEmulators.delete(instance.avdName);
  }

  async shutdownAll(): Promise<void> {
    for (const instance of this.activeEmulators.values()) {
      try {
        instance.process.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.activeEmulators.clear();
  }
}

export const defaultEmulatorPool = new EmulatorPool();

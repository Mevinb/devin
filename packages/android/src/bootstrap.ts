import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { AvdProfile } from "./profiles.js";

const execAsync = promisify(exec);

export interface BootstrapResult {
  success: boolean;
  message: string;
  commandRun?: string;
}

export class AndroidBootstrap {
  private getSdkPath(): string {
    return (
      process.env.ANDROID_HOME ||
      process.env.ANDROID_SDK_ROOT ||
      path.join(process.env.HOME || "", "Android/Sdk")
    );
  }

  private getAvdManagerPath(): string {
    return path.join(this.getSdkPath(), "cmdline-tools/latest/bin/avdmanager");
  }

  private getSdkManagerPath(): string {
    return path.join(this.getSdkPath(), "cmdline-tools/latest/bin/sdkmanager");
  }

  async acceptLicenses(): Promise<BootstrapResult> {
    const sdkmanager = this.getSdkManagerPath();
    try {
      await execAsync(`yes | ${sdkmanager} --licenses`);
      return {
        success: true,
        message: "All Android SDK licenses accepted successfully."
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: `Failed to accept licenses: ${(err as Error).message}`,
        command: `${sdkmanager} --licenses`
      } as BootstrapResult;
    }
  }

  async installSystemImage(imagePackage: string): Promise<BootstrapResult> {
    const sdkmanager = this.getSdkManagerPath();
    try {
      await execAsync(`${sdkmanager} --install "${imagePackage}"`);
      return {
        success: true,
        message: `System image ${imagePackage} installed successfully.`
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: `Failed to install system image: ${(err as Error).message}`
      };
    }
  }

  async createAvd(profile: AvdProfile, customAvdName?: string): Promise<BootstrapResult> {
    const avdName = customAvdName || `PixelSentinel_${profile.id}`;
    const avdmanager = this.getAvdManagerPath();
    const cmd = `${avdmanager} create avd -n "${avdName}" -k "${profile.systemImage}" --force`;

    try {
      await execAsync(cmd);
      return {
        success: true,
        message: `AVD "${avdName}" created successfully for profile ${profile.name}.`,
        commandRun: cmd
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: `AVD creation failed: ${(err as Error).message}. Ensure system image ${profile.systemImage} is installed.`,
        commandRun: cmd
      };
    }
  }
}

export const androidBootstrap = new AndroidBootstrap();

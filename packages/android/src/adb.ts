import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface AdbDevice {
  serial: string;
  state: "device" | "offline" | "bootloader" | "unauthorized";
  model?: string;
  product?: string;
  transportId?: string;
}

export class AdbClient {
  constructor(private readonly adbPath: string = "adb") {}

  private async run(args: string, options: { maxBuffer?: number } = {}): Promise<string> {
    const { stdout } = await execAsync(`${this.adbPath} ${args}`, {
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024
    });
    return stdout;
  }

  async listDevices(): Promise<AdbDevice[]> {
    try {
      const output = await this.run("devices -l");
      const lines = output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("List of devices"));

      const devices: AdbDevice[] = [];
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const serial = parts[0];
        const state = parts[1] as AdbDevice["state"];

        const modelMatch = line.match(/model:(\S+)/);
        const productMatch = line.match(/product:(\S+)/);
        const transportMatch = line.match(/transport_id:(\S+)/);

        devices.push({
          serial,
          state,
          model: modelMatch ? modelMatch[1] : undefined,
          product: productMatch ? productMatch[1] : undefined,
          transportId: transportMatch ? transportMatch[1] : undefined
        });
      }

      return devices;
    } catch {
      return [];
    }
  }

  async forwardPort(serial: string, localPort: number, remoteSocket: string): Promise<void> {
    await this.run(`-s ${serial} forward tcp:${localPort} ${remoteSocket}`);
  }

  async reversePort(serial: string, remotePort: number, localPort: number): Promise<void> {
    await this.run(`-s ${serial} reverse tcp:${remotePort} tcp:${localPort}`);
  }

  async removeReverse(serial: string, remotePort: number): Promise<void> {
    await this.run(`-s ${serial} reverse --remove tcp:${remotePort}`).catch(() => {});
  }

  async shell(serial: string, command: string): Promise<string> {
    return this.run(`-s ${serial} shell ${command}`);
  }

  async isBootCompleted(serial: string): Promise<boolean> {
    try {
      const output = await this.shell(serial, "getprop sys.boot_completed");
      return output.trim() === "1";
    } catch {
      return false;
    }
  }

  async captureScreenshot(serial: string): Promise<Buffer> {
    const { stdout } = await execAsync(`${this.adbPath} -s ${serial} exec-out screencap -p`, {
      encoding: "buffer",
      maxBuffer: 25 * 1024 * 1024
    });
    return stdout;
  }
}

export const defaultAdbClient = new AdbClient();

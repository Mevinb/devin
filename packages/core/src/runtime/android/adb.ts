import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adbBinary } from "./sdk.js";

const execFileAsync = promisify(execFile);

export interface AdbDevice {
  serial: string;
  state: "device" | "offline" | "bootloader" | "unauthorized" | string;
  model?: string;
  product?: string;
  transportId?: string;
}

export class AdbClient {
  constructor(private readonly adbPath: string = adbBinary()) {}

  async run(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
    const { stdout } = await execFileAsync(this.adbPath, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeoutMs ?? 60000
    });
    return stdout;
  }

  async listDevices(): Promise<AdbDevice[]> {
    try {
      const output = await this.run(["devices", "-l"]);
      return output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("List of devices") && !l.startsWith("*"))
        .map((line) => {
          const [serial, state] = line.split(/\s+/);
          return {
            serial,
            state,
            model: line.match(/model:(\S+)/)?.[1],
            product: line.match(/product:(\S+)/)?.[1],
            transportId: line.match(/transport_id:(\S+)/)?.[1]
          };
        });
    } catch {
      return [];
    }
  }

  async forwardPort(serial: string, localPort: number, remoteSocket: string): Promise<void> {
    await this.run(["-s", serial, "forward", `tcp:${localPort}`, remoteSocket]);
  }

  async reversePort(serial: string, remotePort: number, localPort: number): Promise<void> {
    await this.run(["-s", serial, "reverse", `tcp:${remotePort}`, `tcp:${localPort}`]);
  }

  async removeReverse(serial: string, remotePort: number): Promise<void> {
    await this.run(["-s", serial, "reverse", "--remove", `tcp:${remotePort}`]).catch(() => {});
  }

  async shell(serial: string, command: string, timeoutMs?: number): Promise<string> {
    return this.run(["-s", serial, "shell", command], { timeoutMs });
  }

  async emu(serial: string, command: string): Promise<string> {
    return this.run(["-s", serial, "emu", ...command.split(" ")]);
  }

  async install(serial: string, apkPath: string): Promise<void> {
    await this.run(["-s", serial, "install", "-r", "-g", apkPath], { timeoutMs: 180000 });
  }

  async isPackageInstalled(serial: string, pkg: string): Promise<boolean> {
    const out = await this.shell(serial, `pm list packages ${pkg}`).catch(() => "");
    return out.split("\n").some((l) => l.trim() === `package:${pkg}`);
  }

  async isBootCompleted(serial: string): Promise<boolean> {
    try {
      const output = await this.shell(serial, "getprop sys.boot_completed", 10000);
      return output.trim() === "1";
    } catch {
      return false;
    }
  }

  async captureScreenshot(serial: string): Promise<Buffer> {
    const { stdout } = await execFileAsync(this.adbPath, ["-s", serial, "exec-out", "screencap", "-p"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000
    });
    return stdout;
  }

  async keyevent(serial: string, code: number | string): Promise<void> {
    await this.shell(serial, `input keyevent ${code}`);
  }
}

export const defaultAdbClient = new AdbClient();

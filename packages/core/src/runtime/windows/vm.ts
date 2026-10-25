import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowsVmConfig {
  memoryMb: number;
  cpus: number;
  /** Host port forwarded to `playwright run-server` inside the guest. */
  playwrightPort: number;
  /** Internal qcow2 snapshot taken after provisioning; restored on every start. */
  snapshot?: string;
  provisioned: boolean;
}

export function windowsVmDir(): string {
  return process.env.PIXELSENTINEL_WINDOWS_VM_DIR || path.join(os.homedir(), ".pixelsentinel", "windows-vm");
}

export function readWindowsVmConfig(): WindowsVmConfig | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(windowsVmDir(), "vm.json"), "utf8")) as WindowsVmConfig;
  } catch {
    return null;
  }
}

export function writeWindowsVmConfig(cfg: WindowsVmConfig): void {
  fs.mkdirSync(windowsVmDir(), { recursive: true });
  fs.writeFileSync(path.join(windowsVmDir(), "vm.json"), JSON.stringify(cfg, null, 2));
}

export function waitForPort(port: number, timeoutMs: number, host = "127.0.0.1"): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect(port, host);
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 2000);
      });
    };
    attempt();
  });
}

/** Send a single QMP command over the VM's unix socket. */
export async function qmp(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const sockPath = path.join(windowsVmDir(), "qmp.sock");
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buf = "";
    let stage = 0;
    sock.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (stage === 0 && msg.QMP) {
          stage = 1;
          sock.write(JSON.stringify({ execute: "qmp_capabilities" }) + "\n");
        } else if (stage === 1 && "return" in msg) {
          stage = 2;
          sock.write(JSON.stringify({ execute: command, arguments: args }) + "\n");
        } else if (stage === 2 && ("return" in msg || "error" in msg)) {
          sock.end();
          if (msg.error) reject(new Error(msg.error.desc));
          else resolve(msg.return);
        }
      }
    });
    sock.on("error", reject);
  });
}

/** QEMU/KVM lifecycle for the provisioned Windows guest that hosts `playwright run-server`. */
export class WindowsVm {
  constructor(private readonly cfg: WindowsVmConfig) {}

  get dir(): string {
    return windowsVmDir();
  }

  get endpoint(): string {
    return `ws://127.0.0.1:${this.cfg.playwrightPort}/`;
  }

  isRunning(): boolean {
    try {
      const pid = Number(fs.readFileSync(path.join(this.dir, "vm.pid"), "utf8").trim());
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  qemuArgs(extra: string[] = []): string[] {
    const d = this.dir;
    return [
      "-name", "pixelsentinel-windows",
      "-machine", "q35,accel=kvm",
      "-cpu", "host",
      "-smp", String(this.cfg.cpus),
      "-m", String(this.cfg.memoryMb),
      "-drive", `file=${path.join(d, "disk.qcow2")},if=none,id=disk0,format=qcow2`,
      "-device", "ahci,id=ahci",
      "-device", "ide-hd,drive=disk0,bus=ahci.0",
      "-nic", `user,model=e1000e,hostfwd=tcp:127.0.0.1:${this.cfg.playwrightPort}-:3100`,
      "-vga", "std",
      "-display", "none",
      "-qmp", `unix:${path.join(d, "qmp.sock")},server,nowait`,
      "-pidfile", path.join(d, "vm.pid"),
      "-daemonize",
      ...extra
    ];
  }

  async start(timeoutMs = 300000): Promise<string> {
    if (!this.isRunning()) {
      const extra = this.cfg.snapshot ? ["-loadvm", this.cfg.snapshot] : [];
      await execFileAsync("qemu-system-x86_64", this.qemuArgs(extra));
    }
    if (!(await waitForPort(this.cfg.playwrightPort, timeoutMs))) {
      throw new Error(`Windows VM did not expose playwright run-server on port ${this.cfg.playwrightPort}`);
    }
    return this.endpoint;
  }

  async saveSnapshot(name = "provisioned"): Promise<void> {
    await qmp("human-monitor-command", { "command-line": `savevm ${name}` });
    writeWindowsVmConfig({ ...this.cfg, snapshot: name, provisioned: true });
  }

  async stop(): Promise<void> {
    if (!this.isRunning()) return;
    // Discard guest changes: with -loadvm the next start restores the clean snapshot anyway.
    await qmp("quit").catch(() => {
      const pid = Number(fs.readFileSync(path.join(this.dir, "vm.pid"), "utf8").trim());
      process.kill(pid, "SIGTERM");
    });
  }

  /** Run the installer interactively-less: Windows ISO + our unattend ISO attached. */
  static spawnInstaller(cfg: WindowsVmConfig, windowsIso: string, unattendIso: string): ReturnType<typeof spawn> {
    const vm = new WindowsVm(cfg);
    const args = vm
      .qemuArgs([
        "-drive", `file=${windowsIso},media=cdrom,index=1`,
        "-drive", `file=${unattendIso},media=cdrom,index=2`,
        "-boot", "once=d"
      ])
      .filter((a) => a !== "-daemonize");
    return spawn("qemu-system-x86_64", args, { stdio: "inherit" });
  }
}

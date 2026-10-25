import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AdbClient, defaultAdbClient } from "./adb.js";
import { avdDirectory, avdExists, avdHome, emulatorBinary, emulatorInstalled } from "./sdk.js";

export interface EmulatorInstance {
  avd: string;
  serial: string;
  port: number;
  owned: boolean;
  process?: ChildProcess;
  bootMs: number;
}

export interface BootOptions {
  timeoutMs?: number;
  snapshots?: boolean;
  headless?: boolean;
  onLog?: (msg: string) => void;
  signal?: AbortSignal;
}

const BOOT_TIMEOUT_MS = Number(process.env.PIXELSENTINEL_EMULATOR_BOOT_TIMEOUT_MS || 240000);

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** Quickboot snapshots cost ~RAM-size of disk per AVD; only default them on when there is room. */
export function snapshotsEnabledByDefault(): boolean {
  const env = process.env.PIXELSENTINEL_EMULATOR_SNAPSHOTS;
  if (env !== undefined) return env === "1" || env === "true";
  try {
    const stat = fs.statfsSync(avdHome());
    return (stat.bavail * stat.bsize) / 1024 ** 3 > 25;
  } catch {
    return false;
  }
}

export interface EmulatorPoolOptions {
  maxInstances?: number;
  memoryBudgetMb?: number;
}

export class EmulatorManager {
  private instances = new Map<string, EmulatorInstance>();
  private booting = new Map<string, Promise<EmulatorInstance>>();
  private bootControllers = new Map<string, AbortController>();
  private leased = new Set<string>();
  private memory = new Map<string, number>();
  private reservedPorts = new Set<number>();
  private changed = new Set<() => void>();
  private revision = 0;
  private epoch = 0;
  private closing = false;
  private scheduling: Promise<void> = Promise.resolve();
  readonly maxInstances: number;
  readonly memoryBudgetMb: number;

  constructor(private readonly adb: AdbClient = defaultAdbClient, options: EmulatorPoolOptions = {}) {
    this.maxInstances = options.maxInstances ?? EmulatorManager.maxParallel();
    this.memoryBudgetMb = options.memoryBudgetMb ?? Math.max(2048, Math.floor(os.totalmem() / 1024 ** 2) - 4096);
    if (!Number.isInteger(this.maxInstances) || this.maxInstances < 1 || !Number.isFinite(this.memoryBudgetMb) || this.memoryBudgetMb < 1) throw new Error("Invalid emulator pool limits");
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.scheduling.then(operation);
    this.scheduling = pending.then(() => {}, () => {});
    return pending;
  }
  private notify(): void { this.revision++; for (const callback of [...this.changed]) callback(); }
  private async waitForChange(revision: number, deadline: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (revision !== this.revision) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Timed out waiting for an emulator pool lease");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); this.changed.delete(done); signal?.removeEventListener("abort", abort); };
      const done = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal!.reason); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for an emulator pool lease")); }, remaining);
      this.changed.add(done);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  private ramCost(avd: string): number {
    try {
      const config = fs.readFileSync(path.join(avdDirectory(avd), "config.ini"), "utf8");
      return Number(config.match(/^hw.ramSize\s*=\s*(\d+)/m)?.[1] ?? 3072) + 512;
    } catch { return 3584; }
  }
  private fits(memory: number): boolean {
    const count = [...this.memory].filter(([avd, mb]) => mb > 0 || this.leased.has(avd)).length;
    return count < this.maxInstances && [...this.memory.values()].reduce((a, b) => a + b, memory) <= this.memoryBudgetMb;
  }
  private forget(instance: EmulatorInstance): void {
    this.instances.delete(instance.avd); this.leased.delete(instance.avd); this.memory.delete(instance.avd);
    this.reservedPorts.delete(instance.port); this.notify();
  }

  async findRunning(avd: string): Promise<string | null> {
    const devices = await this.adb.listDevices();
    for (const d of devices) {
      if (!d.serial.startsWith("emulator-") || d.state !== "device") continue;
      const out = await this.adb.emu(d.serial, "avd name").catch(() => "");
      if (out.split("\n")[0]?.trim() === avd) return d.serial;
    }
    return null;
  }

  private async allocatePort(): Promise<number> {
    const used = new Set((await this.adb.listDevices()).map((d) => d.serial));
    for (let port = 5554; port <= 5682; port += 2) {
      if (used.has(`emulator-${port}`) || this.reservedPorts.has(port)) continue;
      if ((await portFree(port)) && (await portFree(port + 1)) && !this.reservedPorts.has(port)) {
        this.reservedPorts.add(port); return port;
      }
    }
    throw new Error("No free emulator console port in range 5554-5682");
  }

  async acquire(avd: string, options: BootOptions = {}): Promise<EmulatorInstance> {
    avdDirectory(avd); // validate before the name reaches paths or child-process arguments
    const epoch = this.epoch;
    const assertActive = () => {
      options.signal?.throwIfAborted();
      if (this.closing || this.epoch !== epoch) throw new Error("Emulator pool was shut down while waiting for a lease");
    };
    const deadline = Date.now() + (options.timeoutMs ?? BOOT_TIMEOUT_MS);
    for (;;) {
      assertActive();
      const revision = this.revision;
      const reservation = await this.serial(async () => {
        assertActive();
        if (this.leased.has(avd) || this.booting.has(avd)) return null;
        const cached = this.instances.get(avd);
        if (cached) {
          if (!cached.owned && !this.fits(0)) return null;
          const healthy = await this.adb.isBootCompleted(cached.serial);
          assertActive();
          if (healthy) { this.leased.add(avd); return { promise: Promise.resolve(cached) }; }
          await this.stopOwned(cached); this.forget(cached);
        }
        const connected = await this.findRunning(avd);
        assertActive();
        const memory = connected ? 0 : this.ramCost(avd);
        if (memory > this.memoryBudgetMb) throw new Error(`AVD '${avd}' needs about ${memory} MiB; emulator pool budget is ${this.memoryBudgetMb} MiB`);
        while (!this.fits(memory)) {
          const idle = [...this.instances.values()].find((entry) => entry.owned && !this.leased.has(entry.avd));
          if (!idle) return null;
          options.onLog?.(`Stopping idle ${idle.avd} to free an emulator pool slot`);
          await this.stopOwned(idle); this.forget(idle);
          assertActive();
        }
        assertActive();
        this.leased.add(avd); this.memory.set(avd, memory);
        const controller = new AbortController(); this.bootControllers.set(avd, controller);
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        const promise = this.boot(avd, { ...options, signal }).then(async (instance) => {
          if (signal.aborted) { await this.stopOwned(instance); throw signal.reason; }
          this.instances.set(avd, instance); if (!instance.owned) this.memory.set(avd, 0); this.notify(); return instance;
        }).catch((error) => { this.leased.delete(avd); this.memory.delete(avd); this.notify(); throw error; })
          .finally(() => { this.booting.delete(avd); this.bootControllers.delete(avd); });
        this.booting.set(avd, promise);
        return { promise };
      });
      if (reservation) {
        const instance = await reservation.promise;
        if (this.epoch !== epoch) throw new Error("Emulator pool was shut down during boot");
        return instance;
      }
      options.onLog?.(`Waiting for an available emulator pool lease for ${avd}`);
      await this.waitForChange(revision, deadline, options.signal);
    }
  }

  /** End a session lease. Keep healthy emulators warm; evict only idle owned instances on demand. */
  releaseLease(instance: EmulatorInstance): void {
    if (this.instances.get(instance.avd) !== instance) return;
    this.leased.delete(instance.avd); this.notify();
  }

  protected async boot(avd: string, options: BootOptions): Promise<EmulatorInstance> {
    options.signal?.throwIfAborted();
    const started = Date.now();
    const existing = await this.findRunning(avd);
    if (existing) {
      await this.prepare(existing, options.signal);
      return { avd, serial: existing, port: Number(existing.split("-")[1]), owned: false, bootMs: 0 };
    }

    if (!emulatorInstalled()) {
      throw new Error(`Android emulator not installed at ${emulatorBinary()}. Run 'pixelsentinel devices install'.`);
    }
    if (!avdExists(avd)) {
      throw new Error(`AVD '${avd}' does not exist. Run 'pixelsentinel devices create'.`);
    }

    if (process.platform === "linux") {
      try { fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK); }
      catch { throw new Error("Cannot boot a new accelerated emulator: /dev/kvm is unavailable. Run devices doctor; already-connected emulators remain usable."); }
    }
    const port = await this.allocatePort();
    if (options.signal?.aborted) { this.reservedPorts.delete(port); options.signal.throwIfAborted(); }
    const serial = `emulator-${port}`;
    const snapshots = options.snapshots ?? snapshotsEnabledByDefault();
    const args = [
      "-avd", avd,
      "-port", String(port),
      "-no-audio",
      "-no-boot-anim",
      "-gpu", process.env.PIXELSENTINEL_EMULATOR_GPU || "swiftshader_indirect",
      "-netdelay", "none",
      "-netspeed", "full",
      ...(options.headless === false ? [] : ["-no-window"]),
      ...(snapshots ? [] : ["-no-snapshot"])
    ];
    options.onLog?.(`Booting ${avd} on ${serial} (${snapshots ? "quickboot" : "cold boot"})`);

    // Log to a file (not a pipe) so the emulator survives if this process exits first.
    const logPath = path.join(os.tmpdir(), `pixelsentinel-emulator-${avd}.log`);
    const logFd = fs.openSync(logPath, "w");
    const child = spawn(emulatorBinary(), args, { detached: true, stdio: ["ignore", logFd, logFd] });
    fs.closeSync(logFd);
    child.unref();
    const readLog = () => {
      try {
        return fs.readFileSync(logPath, "utf8").slice(-1500);
      } catch {
        return "";
      }
    };
    let exited = false;
    let launchError: Error | undefined;
    child.once("exit", () => (exited = true));
    child.once("error", (error) => { launchError = error; });
    const abort = () => { child.kill("SIGTERM"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    try {
      const timeoutMs = options.timeoutMs ?? BOOT_TIMEOUT_MS;
      while (Date.now() - started < timeoutMs) {
        options.signal?.throwIfAborted();
        if (launchError) throw launchError;
        if (exited) {
          throw new Error(`Emulator '${avd}' exited during boot:\n${readLog()}`);
        }
        if (await this.adb.isBootCompleted(serial)) break;
        await delay(2000, undefined, { signal: options.signal });
      }
      if (!(await this.adb.isBootCompleted(serial))) {
        child.kill("SIGKILL");
        throw new Error(`Emulator '${avd}' failed to boot within ${Math.round(timeoutMs / 1000)}s:\n${readLog()}`);
      }
  
      await this.prepare(serial, options.signal);
      const bootMs = Date.now() - started;
      options.onLog?.(`${avd} ready on ${serial} in ${(bootMs / 1000).toFixed(1)}s`);
      return { avd, serial, port, owned: true, process: child, bootMs };
    } catch (error) {
      await this.stopOwned({ avd, serial, port, owned: true, process: child, bootMs: 0 });
      this.reservedPorts.delete(port);
      throw error;
    } finally { options.signal?.removeEventListener("abort", abort); }
  }

  /** Make the device deterministic for screenshots: no animations, screen on, unlocked. */
  async prepare(serial: string, signal?: AbortSignal): Promise<void> {
    const cmds = [
      "settings put global window_animation_scale 0",
      "settings put global transition_animation_scale 0",
      "settings put global animator_duration_scale 0",
      "svc power stayon true",
      "settings put system screen_off_timeout 2147483647",
      "input keyevent 224",
      "wm dismiss-keyguard",
      // Granting up front suppresses Chrome's "notifications make things easier" promo dialog
      "pm grant com.android.chrome android.permission.POST_NOTIFICATIONS",
      // Keep the real soft keyboard on screen even though the emulator exposes a hardware keyboard
      "settings put secure show_ime_with_hard_keyboard 1"
    ];
    for (const c of cmds) {
      signal?.throwIfAborted();
      await this.adb.shell(serial, c).catch(() => {});
    }
    // Wait for package manager to be responsive (boot_completed can precede it)
    for (let i = 0; i < 30; i++) {
      signal?.throwIfAborted();
      const out = await this.adb.shell(serial, "pm path android").catch(() => "");
      if (out.includes("package:")) break;
      await delay(1000, undefined, { signal });
    }
  }

  protected async stopOwned(instance: EmulatorInstance): Promise<void> {
    if (!instance.owned) return;
    if (instance.process && (!instance.process.pid || instance.process.exitCode !== null || instance.process.signalCode !== null)) return;
    await this.adb.emu(instance.serial, "kill").catch(() => instance.process?.kill("SIGTERM"));
    await new Promise<void>((resolve) => {
      if (!instance.process || instance.process.exitCode !== null || instance.process.signalCode !== null) return resolve();
      const t = setTimeout(() => {
        instance.process?.kill("SIGKILL");
        resolve();
      }, 20000);
      instance.process.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async release(instance: EmulatorInstance): Promise<void> {
    await this.serial(async () => {
      if (this.instances.get(instance.avd) !== instance) return;
      await this.stopOwned(instance); this.forget(instance);
    });
  }

  running(): EmulatorInstance[] {
    return [...this.instances.values()];
  }

  async cancelPendingBoots(): Promise<void> {
    this.epoch++; this.notify();
    for (const controller of this.bootControllers.values()) controller.abort(new Error("Emulator pool was shut down during boot"));
    await Promise.allSettled([...this.booting.values()]);
  }

  async shutdownAll(): Promise<void> {
    this.closing = true;
    try {
      await this.cancelPendingBoots();
      await Promise.all([...this.instances.values()].map((instance) => this.release(instance)));
    } finally { this.closing = false; this.notify(); }
  }

  /** Rough parallelism limit: ~3 GB per emulator, keep 4 GB for the host. */
  static maxParallel(): number {
    return Math.max(1, Math.floor((os.totalmem() / 1024 ** 3 - 4) / 3));
  }
}

export const defaultEmulatorManager = new EmulatorManager();

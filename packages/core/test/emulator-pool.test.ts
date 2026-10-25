import { describe, expect, it } from "vitest";
import { AdbClient, type AdbDevice } from "../src/runtime/android/adb.js";
import { EmulatorManager, type BootOptions, type EmulatorInstance, type EmulatorPoolOptions } from "../src/runtime/android/emulator.js";

class FakeAdb extends AdbClient {
  health = new Map<string, boolean>();
  connected: AdbDevice[] = [];
  commands: string[] = [];
  async listDevices() { return this.connected; }
  async isBootCompleted(serial: string) { return this.health.get(serial) ?? true; }
  async emu(_serial: string, command: string) { this.commands.push(command); return command === "avd name" ? "borrowed\nOK" : "OK"; }
  async shell(_serial: string, command: string) { return command === "pm path android" ? "package:/system/framework/framework-res.apk" : ""; }
}
class SimulatedPool extends EmulatorManager {
  boots: string[] = [];
  stopped: string[] = [];
  failNext = false;
  constructor(readonly fakeAdb = new FakeAdb(), options: EmulatorPoolOptions = { maxInstances: 1, memoryBudgetMb: 16000 }) { super(fakeAdb, options); }
  async findRunning() { return null; }
  protected async boot(avd: string, _options: BootOptions): Promise<EmulatorInstance> {
    this.boots.push(avd);
    if (this.failNext) { this.failNext = false; throw new Error("Simulated boot failure"); }
    return { avd, serial: `emulator-${6000 + this.boots.length * 2}`, port: 6000 + this.boots.length * 2, owned: true, bootMs: 1 };
  }
  protected async stopOwned(instance: EmulatorInstance) { if (instance.owned) this.stopped.push(instance.avd); }
}
function waiting(pool: EmulatorManager, avd: string) {
  let notify!: () => void;
  const seen = new Promise<void>((resolve) => { notify = resolve; });
  const pending = pool.acquire(avd, { timeoutMs: 2000, onLog: (message) => { if (message.startsWith("Waiting")) notify(); } });
  return { pending, seen };
}

describe("Emulator pool ownership, leases and resource bounds", () => {
  it("queues a second session on the same AVD and reuses the instance only after release", async () => {
    const pool = new SimulatedPool();
    try {
      const first = await pool.acquire("phone");
      const second = waiting(pool, "phone"); await second.seen;
      expect(pool.boots).toEqual(["phone"]); expect(pool.stopped).toEqual([]);
      pool.releaseLease(first);
      expect(await second.pending).toBe(first); expect(pool.boots).toHaveLength(1);
    } finally { await pool.shutdownAll(); }
  });
  it("evicts an idle owned device to admit another profile instead of deadlocking the scan", async () => {
    const pool = new SimulatedPool();
    try {
      const first = await pool.acquire("phone");
      const second = waiting(pool, "tablet"); await second.seen;
      expect(pool.stopped).toEqual([]);
      pool.releaseLease(first); const tablet = await second.pending;
      expect(tablet.avd).toBe("tablet"); expect(pool.stopped).toEqual(["phone"]);
      expect(pool.running().map((instance) => instance.avd)).toEqual(["tablet"]);
    } finally { await pool.shutdownAll(); }
  });
  it("bounds allocated RAM even when the instance-count limit allows more devices", async () => {
    const pool = new SimulatedPool(new FakeAdb(), { maxInstances: 3, memoryBudgetMb: 4000 });
    try {
      const first = await pool.acquire("phone");
      const second = waiting(pool, "tablet"); await second.seen;
      expect(pool.boots).toHaveLength(1);
      pool.releaseLease(first); await second.pending;
      expect(pool.stopped).toEqual(["phone"]);
    } finally { await pool.shutdownAll(); }
    const tooSmall = new SimulatedPool(new FakeAdb(), { maxInstances: 3, memoryBudgetMb: 1000 });
    await expect(tooSmall.acquire("phone")).rejects.toThrow(/pool budget/);
  });
  it("restarts a failed health check and frees reservations after boot failures", async () => {
    const pool = new SimulatedPool();
    try {
      pool.failNext = true; await expect(pool.acquire("phone")).rejects.toThrow("Simulated boot failure");
      const first = await pool.acquire("phone"); pool.releaseLease(first); pool.fakeAdb.health.set(first.serial, false);
      const recovered = await pool.acquire("phone");
      expect(recovered.serial).not.toBe(first.serial); expect(pool.stopped).toEqual(["phone"]);
    } finally { await pool.shutdownAll(); }
  });
  it("rejects queued requests during shutdown and can serve a later scan", async () => {
    const pool = new SimulatedPool();
    await pool.acquire("phone"); const queued = waiting(pool, "phone"); await queued.seen;
    const rejected = expect(queued.pending).rejects.toThrow(/shut down/);
    await pool.shutdownAll(); await rejected;
    try { expect((await pool.acquire("tablet")).avd).toBe("tablet"); }
    finally { await pool.shutdownAll(); }
  });
  it("never shuts down a borrowed already-connected emulator", async () => {
    const adb = new FakeAdb(); adb.connected = [{ serial: "emulator-5554", state: "device" }];
    const pool = new EmulatorManager(adb, { maxInstances: 1, memoryBudgetMb: 4000 });
    const instance = await pool.acquire("borrowed");
    expect(instance.owned).toBe(false);
    pool.releaseLease(instance); await pool.shutdownAll();
    expect(adb.commands).not.toContain("kill"); expect(pool.running()).toEqual([]);
  });
  it("cancels pending boots while preserving healthy warm instances", async () => {
    let started!: () => void; const bootStarted = new Promise<void>((resolve) => { started = resolve; });
    class AbortablePool extends SimulatedPool {
      protected async boot(avd: string, options: BootOptions): Promise<EmulatorInstance> {
        if (avd !== "tablet") return super.boot(avd, options);
        started();
        return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
      }
    }
    const pool = new AbortablePool(new FakeAdb(), { maxInstances: 2, memoryBudgetMb: 16000 });
    try {
      const phone = await pool.acquire("phone"); pool.releaseLease(phone);
      const pending = pool.acquire("tablet"), rejected = expect(pending).rejects.toThrow(/shut down/); await bootStarted;
      await pool.cancelPendingBoots(); await rejected;
      expect(pool.running()).toEqual([phone]); expect(pool.stopped).toEqual([]);
      expect(await pool.acquire("phone")).toBe(phone);
    } finally { await pool.shutdownAll(); }
  });
  it("aborts a queued lease request without disturbing the active lease", async () => {
    const pool = new SimulatedPool(), controller = new AbortController();
    try {
      const phone = await pool.acquire("phone");
      let queued!: () => void; const waiting = new Promise<void>((resolve) => { queued = resolve; });
      const pending = pool.acquire("phone", { signal: controller.signal, onLog: () => queued() });
      const rejected = expect(pending).rejects.toThrow("Cancelled lease"); await waiting;
      controller.abort(new Error("Cancelled lease")); await rejected;
      expect(pool.running()).toEqual([phone]); expect(pool.stopped).toEqual([]);
    } finally { await pool.shutdownAll(); }
  });
});

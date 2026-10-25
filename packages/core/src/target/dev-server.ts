import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { DevServerConfig } from "../config/schema.js";
import type { TargetResolution } from "./types.js";

async function isPortOpen(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function waitForPort(
  port: number,
  timeoutMs: number,
  host: string = "127.0.0.1",
  signal?: AbortSignal
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    signal?.throwIfAborted();
    if (await isPortOpen(port, host)) {
      return;
    }
    await delay(250, undefined, { signal });
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for dev server port ${port}`);
}

export async function startDevServer(
  config: DevServerConfig,
  cwd: string = process.cwd(),
  signal?: AbortSignal
): Promise<TargetResolution> {
  if (!config.command) {
    throw new Error("Dev server command is required");
  }
  signal?.throwIfAborted();

  let port = config.port ?? 5173;
  if (port === 0) {
    port = await new Promise<number>((resolve, reject) => {
      const reservation = net.createServer();
      reservation.on("error", reject);
      reservation.listen(0, "127.0.0.1", () => {
        const address = reservation.address() as net.AddressInfo;
        reservation.close(() => resolve(address.port));
      });
    });
  }
  if (await isPortOpen(port)) throw new Error(`Dev server port ${port} is already in use; refusing to scan an unrelated server`);
  signal?.throwIfAborted();
  const timeoutMs = config.readyTimeoutMs || 30000;

  const child: ChildProcess = spawn(config.command.replaceAll("{port}", String(port)), {
    shell: true,
    cwd,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: { ...process.env, PORT: String(port) }
  });

  const killProcess = async () => {
    if (child.pid) {
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // Ignore kill errors if already terminated
      }
    }
  };

  const abort = () => { void killProcess(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await waitForPort(port, timeoutMs, "127.0.0.1", signal);
  } catch (err) {
    await killProcess();
    signal?.removeEventListener("abort", abort);
    throw err;
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    isLocal: true,
    cleanup: async () => { signal?.removeEventListener("abort", abort); await killProcess(); }
  };
}

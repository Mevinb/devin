import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
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
  host: string = "127.0.0.1"
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await isPortOpen(port, host)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for dev server port ${port}`);
}

export async function startDevServer(
  config: DevServerConfig,
  cwd: string = process.cwd()
): Promise<TargetResolution> {
  if (!config.command) {
    throw new Error("Dev server command is required");
  }

  const port = config.port || 5173;
  const timeoutMs = config.readyTimeoutMs || 30000;

  const child: ChildProcess = spawn(config.command, {
    shell: true,
    cwd,
    stdio: "inherit",
    detached: process.platform !== "win32"
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

  try {
    await waitForPort(port, timeoutMs);
  } catch (err) {
    await killProcess();
    throw err;
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    isLocal: true,
    cleanup: killProcess
  };
}

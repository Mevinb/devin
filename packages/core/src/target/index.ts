import type { ScanConfig } from "../config/schema.js";
import fs from "node:fs";
import path from "node:path";
import { startDevServer } from "./dev-server.js";
import { startStaticServer } from "./static-server.js";
import type { TargetResolution } from "./types.js";

export * from "./types.js";
export * from "./static-server.js";
export * from "./dev-server.js";

export async function resolveTarget(
  config: ScanConfig,
  cwd: string = process.cwd(),
  signal?: AbortSignal
): Promise<TargetResolution> {
  signal?.throwIfAborted();
  if (config.devServer && config.devServer.command) {
    const project = path.resolve(cwd, config.target);
    const projectCwd = !/^https?:\/\//i.test(config.target) && fs.existsSync(project)
      ? fs.statSync(project).isDirectory() ? project : path.dirname(project)
      : cwd;
    return startDevServer(config.devServer, projectCwd, signal);
  }

  const target = config.target.trim();

  // URL target
  if (/^https?:\/\//i.test(target)) {
    return {
      url: target,
      isLocal: false,
      cleanup: async () => {}
    };
  }

  // Local filesystem directory or file
  return startStaticServer(target);
}

import type { ScanConfig } from "../config/schema.js";
import { startDevServer } from "./dev-server.js";
import { startStaticServer } from "./static-server.js";
import type { TargetResolution } from "./types.js";

export * from "./types.js";
export * from "./static-server.js";
export * from "./dev-server.js";

export async function resolveTarget(
  config: ScanConfig,
  cwd: string = process.cwd()
): Promise<TargetResolution> {
  if (config.devServer && config.devServer.command) {
    return startDevServer(config.devServer, cwd);
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

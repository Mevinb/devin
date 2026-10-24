import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { ScanConfigSchema, type ScanConfig, type ScanConfigInput } from "./schema.js";

const DEFAULT_CONFIG_FILENAMES = [
  "pixelsentinel.config.json",
  "pixelsentinel.config.js",
  "pixelsentinel.config.mjs",
  "pixelsentinel.config.ts"
];

export async function findConfigFile(cwd: string = process.cwd()): Promise<string | null> {
  for (const filename of DEFAULT_CONFIG_FILENAMES) {
    const fullPath = path.resolve(cwd, filename);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

export async function loadConfigFile(filepath: string): Promise<Record<string, unknown>> {
  const ext = path.extname(filepath).toLowerCase();
  if (ext === ".json") {
    const content = fs.readFileSync(filepath, "utf8");
    return JSON.parse(content);
  }

  // Use dynamic import for js/ts/mjs
  const fileUrl = pathToFileURL(filepath).href;
  const mod = await import(fileUrl);
  return mod.default || mod;
}

export async function resolveScanConfig(
  input: Partial<ScanConfigInput>,
  customConfigPath?: string,
  cwd: string = process.cwd()
): Promise<ScanConfig> {
  let fileConfig: Record<string, unknown> = {};

  const configPath = customConfigPath
    ? path.resolve(cwd, customConfigPath)
    : await findConfigFile(cwd);

  if (configPath && fs.existsSync(configPath)) {
    fileConfig = await loadConfigFile(configPath);
  }

  // Deep merge CLI input over file config
  const merged: Record<string, unknown> = {
    ...fileConfig,
    ...input,
    vision: {
      ...(typeof fileConfig.vision === "object" && fileConfig.vision !== null ? fileConfig.vision : {}),
      ...(input.vision || {})
    },
    output: {
      ...(typeof fileConfig.output === "object" && fileConfig.output !== null ? fileConfig.output : {}),
      ...(input.output || {})
    },
    devServer: {
      ...(typeof fileConfig.devServer === "object" && fileConfig.devServer !== null ? fileConfig.devServer : {}),
      ...(input.devServer || {})
    }
  };

  return ScanConfigSchema.parse(merged);
}

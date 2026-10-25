import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function androidSdkRoot(): string {
  return (
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    path.join(os.homedir(), "Android", "Sdk")
  );
}

export function sdkPath(...segments: string[]): string {
  return path.join(androidSdkRoot(), ...segments);
}

/** Prefer the SDK's platform-tools adb (matches the emulator version) over a system adb. */
export function adbBinary(): string {
  const sdkAdb = sdkPath("platform-tools", "adb");
  return existsSync(sdkAdb) ? sdkAdb : "adb";
}

export function emulatorBinary(): string {
  return sdkPath("emulator", "emulator");
}

export function avdHome(): string {
  return process.env.ANDROID_AVD_HOME || path.join(androidUserHome(), "avd");
}

export function androidUserHome(): string {
  return process.env.ANDROID_USER_HOME || path.join(os.homedir(), ".android");
}

export function commandLineTool(name: "sdkmanager" | "avdmanager" | "android", root = androidSdkRoot()): string | null {
  const base = path.join(root, "cmdline-tools");
  const executable = process.platform === "win32" && name !== "android" ? `${name}.bat` : name;
  const candidates = ["latest"];
  try { candidates.push(...readdirSync(base).filter((dir) => dir !== "latest").sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))); }
  catch { return null; }
  return candidates.map((dir) => path.join(base, dir, "bin", executable)).find((file) => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile() && statSync(file).size > 0; }
    catch { return false; }
  }) ?? null;
}

export function avdDirectory(name: string, home = avdHome()): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid AVD name '${name}'`);
  try {
    const ini = readFileSync(path.join(home, `${name}.ini`), "utf8");
    const location = ini.match(/^path\s*=\s*(.+)$/m)?.[1].trim();
    if (location) return path.resolve(location);
  } catch { /* AVDs created with --path may have only their directory. */ }
  return path.join(home, `${name}.avd`);
}

export function avdExists(avdName: string): boolean {
  return existsSync(path.join(avdDirectory(avdName), "config.ini"));
}

export function emulatorInstalled(): boolean {
  return existsSync(emulatorBinary());
}

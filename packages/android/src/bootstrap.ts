import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { androidSdkRoot, androidUserHome, avdDirectory, avdHome, commandLineTool, getAvdProfile, type AvdProfile } from "@pixelsentinel/core";

const exec = promisify(execFile);
// Pinned official archive + SHA-256 from https://developer.android.com/studio#command-tools.
export const COMMAND_LINE_TOOLS = {
  linux: { url: "https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip", sha256: "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583" },
  darwin: { url: "https://dl.google.com/android/repository/commandlinetools-mac_x86_64-15859902_latest.zip", sha256: "c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3" },
  darwinArm: { url: "https://dl.google.com/android/repository/commandlinetools-mac_arm64-15859902_latest.zip", sha256: "835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e" }
} as const;
export interface BootstrapResult { success: boolean; message: string; commandRun?: string; avdPath?: string; installedPackages?: string[]; }
export interface BootstrapOptions {
  sdkRoot?: string;
  avdHome?: string;
  userHome?: string;
  onLog?: (message: string) => void;
  timeoutMs?: number;
  /** Explicit archive override for mirrored/offline installations; a checksum is always required. */
  toolsDownload?: { url: string; sha256: string };
}
export interface InstallOptions { profiles?: string[]; acceptLicenses?: boolean; packages?: string[]; toolsOnly?: boolean; runtimeTools?: boolean; }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }

export class AndroidBootstrap {
  constructor(private readonly options: BootstrapOptions = {}) {}
  get sdkRoot(): string { return path.resolve(this.options.sdkRoot ?? androidSdkRoot()); }
  get avdHome(): string { return path.resolve(this.options.avdHome ?? process.env.ANDROID_AVD_HOME ?? (this.options.userHome ? path.join(this.userHome, "avd") : avdHome())); }
  get userHome(): string { return path.resolve(this.options.userHome ?? androidUserHome()); }
  private async environment() {
    await fs.mkdir(this.userHome, { recursive: true });
    await fs.mkdir(this.avdHome, { recursive: true });
    return { ...process.env, ANDROID_HOME: this.sdkRoot, ANDROID_SDK_ROOT: this.sdkRoot,
      ANDROID_USER_HOME: this.userHome, ANDROID_AVD_HOME: this.avdHome, ANDROID_EMULATOR_HOME: this.userHome };
  }
  private async run(binary: string, args: string[], input = "", timeoutMs = this.options.timeoutMs ?? 30 * 60000): Promise<string> {
    const env = await this.environment();
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      const receive = (chunk: Buffer) => {
        const text = chunk.toString(); output = (output + text).slice(-2 * 1024 * 1024); this.options.onLog?.(text.trimEnd());
      };
      child.stdout.on("data", receive); child.stderr.on("data", receive);
      child.stdin.on("error", () => {}); child.stdin.end(input);
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Android command timed out after ${timeoutMs}ms`)); }, timeoutMs);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => { clearTimeout(timeout); if (code === 0) resolve(output); else reject(new Error(`${path.basename(binary)} exited ${code}: ${output.slice(-3000)}`)); });
    });
  }
  async ensureCommandLineTools(): Promise<BootstrapResult> {
    if (commandLineTool("sdkmanager", this.sdkRoot) && commandLineTool("avdmanager", this.sdkRoot)) return { success: true, message: "Existing Android command-line tools are available; preserved unchanged." };
    const host = process.platform === "darwin" ? process.arch === "arm64" ? "darwinArm" : "darwin" : process.platform;
    const archive = this.options.toolsDownload ?? COMMAND_LINE_TOOLS[host as keyof typeof COMMAND_LINE_TOOLS];
    if (!archive) return { success: false, message: `Automatic command-line tools download is unsupported on ${process.platform}; install official Android tools and set ANDROID_HOME.` };
    if (!/^[a-f\d]{64}$/i.test(archive.sha256)) return { success: false, message: "A valid SHA-256 checksum is required for command-line tools." };
    const directory = path.join(this.sdkRoot, "cmdline-tools");
    let staging: string | undefined;
    try {
      await fs.mkdir(directory, { recursive: true });
      staging = await fs.mkdtemp(path.join(directory, ".pixelsentinel-download-"));
      const response = await fetch(archive.url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error(`Command-line tools download failed: HTTP ${response.status}`);
      const zip = path.join(staging, "tools.zip");
      const hash = crypto.createHash("sha256");
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }), createWriteStream(zip));
      if (hash.digest("hex") !== archive.sha256.toLowerCase()) throw new Error("Command-line tools SHA-256 checksum mismatch");
      const { stdout } = await exec("unzip", ["-Z1", zip], { maxBuffer: 16 * 1024 * 1024 });
      if (stdout.split("\n").some((file) => file.startsWith("/") || file.split(/[\\/]/).includes(".."))) throw new Error("Unsafe path in command-line tools archive");
      await exec("unzip", ["-q", zip, "-d", path.join(staging, "extracted")]);
      const extracted = path.join(staging, "extracted", "cmdline-tools");
      for (const tool of ["sdkmanager", "avdmanager"]) {
        const file = path.join(extracted, "bin", tool);
        if (!await exists(file)) throw new Error(`Downloaded archive is missing ${tool}`);
        await fs.chmod(file, 0o755);
      }
      const destination = path.join(directory, await exists(path.join(directory, "latest")) ? "pixelsentinel-23.0" : "latest");
      if (await exists(destination)) throw new Error(`Refusing to overwrite existing command-line tools at ${destination}`);
      await fs.rename(extracted, destination);
      return { success: true, message: `Installed checksum-verified official command-line tools at ${destination}.` };
    } catch (error) { return { success: false, message: (error as Error).message }; }
    finally { if (staging) await fs.rm(staging, { recursive: true, force: true }); }
  }
  async acceptLicenses(): Promise<BootstrapResult> {
    if (commandLineTool("android", this.sdkRoot)) return { success: true, message: "Modern Android CLI handles SDK terms during installation; no separate sdkmanager --licenses step is required." };
    const tool = commandLineTool("sdkmanager", this.sdkRoot);
    if (!tool) return { success: false, message: "SDK command-line tools are missing; run devices install first." };
    try {
      await this.run(tool, [`--sdk_root=${this.sdkRoot}`, "--licenses"], "y\n".repeat(100));
      return { success: true, message: "Android SDK license command completed." };
    } catch (error) { return { success: false, message: `SDK license command failed: ${(error as Error).message}` }; }
  }
  private async packageInstalled(name: string): Promise<boolean> {
    const folder = path.join(this.sdkRoot, ...name.split(";"));
    if (name.startsWith("system-images;")) return exists(path.join(folder, "system.img"));
    if (name === "emulator") return exists(path.join(folder, process.platform === "win32" ? "emulator.exe" : "emulator"));
    if (name === "platform-tools") return exists(path.join(folder, process.platform === "win32" ? "adb.exe" : "adb"));
    return exists(path.join(folder, "package.xml"));
  }
  async install(options: InstallOptions = {}): Promise<BootstrapResult> {
    const profiles = [];
    for (const id of options.profiles ?? ["pixel_8"]) {
      const profile = getAvdProfile(id);
      if (!profile) return { success: false, message: `Unknown AVD profile '${id}'.` };
      profiles.push(profile);
    }
    const packages = [...new Set([...(options.runtimeTools === false ? [] : ["platform-tools", "emulator"]), ...profiles.map((p) => p.systemImage), ...(options.packages ?? [])])];
    if (packages.some((name) => !name.split(";").every((part) => /^[a-zA-Z0-9_][\w.-]*$/.test(part)))) return { success: false, message: "Invalid Android SDK package identifier." };
    const tools = await this.ensureCommandLineTools(); if (!tools.success || options.toolsOnly) return tools;
    if (options.acceptLicenses) { const accepted = await this.acceptLicenses(); if (!accepted.success) return accepted; }
    const missing: string[] = [];
    for (const name of packages) if (!await this.packageInstalled(name)) missing.push(name);
    if (!missing.length) return { success: true, message: "All requested SDK packages are installed; existing packages were preserved.", installedPackages: packages };
    try {
      const modern = commandLineTool("android", this.sdkRoot);
      await this.run(modern ?? commandLineTool("sdkmanager", this.sdkRoot)!, modern
        ? ["--no-metrics", `--sdk=${this.sdkRoot}`, "sdk", "--ignore-outdated-xmls", "install", "--no-downgrade", ...missing.map((name) => name.replaceAll(";", "/"))]
        : [`--sdk_root=${this.sdkRoot}`, "--install", ...missing], options.acceptLicenses ? "y\n".repeat(100) : "n\n".repeat(100));
      for (const name of missing) if (!await this.packageInstalled(name)) throw new Error(`SDK command exited but package ${name} is incomplete/missing`);
      return { success: true, message: `Installed ${missing.length} SDK packages.`, installedPackages: packages };
    } catch (error) { return { success: false, message: `SDK installation failed: ${(error as Error).message}. If licenses need acceptance, rerun with --accept-licenses.` }; }
  }
  async installSystemImage(imagePackage: string): Promise<BootstrapResult> { return this.install({ profiles: [], packages: [imagePackage] }); }
  async createAvd(profile: AvdProfile, customAvdName = profile.avdName, options: { force?: boolean } = {}): Promise<BootstrapResult> {
    if (!/^[\w.-]+$/.test(customAvdName)) return { success: false, message: "AVD name must contain only letters, digits, underscores, dots or hyphens." };
    const directory = avdDirectory(customAvdName, this.avdHome);
    const ini = path.join(this.avdHome, `${customAvdName}.ini`);
    if ((await exists(directory) || await exists(ini)) && !options.force) return { success: false, message: `AVD '${customAvdName}' already exists; preserved. Choose --name or explicitly use --force.` };
    if (!await this.packageInstalled(profile.systemImage)) return { success: false, message: `Install ${profile.systemImage} first: devices install --profiles ${profile.id}.` };
    const manager = commandLineTool("avdmanager", this.sdkRoot);
    if (!manager) return { success: false, message: "avdmanager is missing; run devices install." };
    const args = ["create", "avd", "--name", customAvdName, "--package", profile.systemImage, "--path", directory,
      ...(profile.hardwareDevice ? ["--device", profile.hardwareDevice] : []), ...(options.force ? ["--force"] : [])];
    try {
      await this.run(manager, args, "no\n", 120000);
      const file = path.join(directory, "config.ini");
      const text = await fs.readFile(file, "utf8");
      const properties = new Map(text.split(/\r?\n/).filter((line) => line.includes("=")).map((line) => { const i = line.indexOf("="); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
      const image = properties.get("image.sysdir.1");
      if (!image || path.resolve(this.sdkRoot, image) !== path.join(this.sdkRoot, ...profile.systemImage.split(";"))) throw new Error("AVD manager selected an unexpected system image");
      if (profile.hardwareDevice && properties.get("hw.device.name") !== profile.hardwareDevice) throw new Error("AVD manager selected an unexpected hardware device");
      for (const [key, value] of Object.entries({
        "hw.lcd.width": String(profile.resolution.width), "hw.lcd.height": String(profile.resolution.height),
        "hw.lcd.density": String(profile.densityDpi), "hw.ramSize": String(profile.ramMb), "hw.keyboard": "no",
        "hw.gpu.enabled": "yes", "hw.gpu.mode": "swiftshader_indirect", "showDeviceFrame": "no", "disk.dataPartition.size": "6G",
        "hw.initialOrientation": profile.resolution.width > profile.resolution.height ? "landscape" : "portrait",
        ...profile.hardwareProperties
      })) properties.set(key, value);
      await fs.writeFile(file, [...properties].map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
      return { success: true, message: `Created ${customAvdName} (${profile.name}) at ${directory}.`, avdPath: directory };
    } catch (error) { return { success: false, message: `AVD creation failed: ${(error as Error).message}` }; }
  }
}
export const androidBootstrap = new AndroidBootstrap();

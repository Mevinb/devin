import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AdbClient, adbBinary, androidSdkRoot, avdDirectory, avdHome, commandLineTool, getAvdProfile } from "@pixelsentinel/core";

const exec = promisify(execFile);
export type CheckStatus = "ok" | "warning" | "error";
export interface DoctorCheck {
  name: string;
  category: "virtualization" | "java" | "android-sdk" | "system";
  status: CheckStatus;
  message: string;
  details?: string;
  recommendation?: string;
}
export interface DoctorReport {
  timestamp: string;
  sdkRoot: string;
  avdHome: string;
  checks: DoctorCheck[];
  allPassed: boolean;
  /** Ready to start a NEW hardware-accelerated emulator with the requested profiles. */
  canEmulate: boolean;
  canUseConnectedDevices: boolean;
  connectedDevices: Array<{ serial: string; state: string }>;
}
export interface DoctorOptions { sdkRoot?: string; avdHome?: string; profiles?: string[]; kvmPath?: string; }
async function accessible(file: string, mode = constants.F_OK): Promise<boolean> {
  try { await fs.access(file, mode); return true; } catch { return false; }
}

export async function runDevicesDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const root = path.resolve(options.sdkRoot ?? androidSdkRoot());
  const avds = path.resolve(options.avdHome ?? avdHome());
  const profiles = (options.profiles ?? ["pixel_8"]).map((id) => {
    const profile = getAvdProfile(id);
    if (!profile) throw new Error(`Unknown AVD profile '${id}'`);
    return profile;
  });
  const checks: DoctorCheck[] = [];
  const check = (name: string, category: DoctorCheck["category"], ok: boolean, message: string, recommendation?: string, optional = false) => {
    checks.push({ name, category, status: ok ? "ok" : optional ? "warning" : "error", message, recommendation: ok ? undefined : recommendation });
    return ok;
  };
  let acceleration = false;
  if (process.platform === "linux") {
    acceleration = await accessible(options.kvmPath ?? "/dev/kvm", constants.R_OK | constants.W_OK);
    check("Hardware Virtualization (KVM)", "virtualization", acceleration,
      acceleration ? "/dev/kvm is readable and writable." : "/dev/kvm is unavailable or not readable/writable in this runtime.",
      "Expose /dev/kvm to the process and grant access (for example, the kvm group). Connected devices can still be used.");
  } else {
    try {
      await exec(path.join(root, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator"), ["-accel-check"], { timeout: 15000 });
      acceleration = true;
    } catch { /* Tool output is represented by the actionable check below. */ }
    check("Emulator acceleration", "virtualization", acceleration, acceleration ? "Emulator acceleration is available." : "Emulator acceleration check failed.", "Install/configure the platform's emulator hypervisor and run emulator -accel-check.");
  }
  let java = false;
  try {
    const result = await exec("java", ["-version"], { timeout: 10000 });
    const version = (result.stderr + result.stdout).match(/(?:version\s+"|openjdk\s+)([\d.]+)/)?.[1] ?? "unknown";
    java = Number(version.split(".")[0]) >= 17;
    check("Java Development Kit (JDK)", "java", java, `Java ${version} detected.`, "Install JDK 17 or newer and configure JAVA_HOME/PATH.");
  } catch { check("Java Development Kit (JDK)", "java", false, "Java is not executable.", "Install JDK 17 or newer."); }
  const sdk = check("Android SDK Root", "android-sdk", await accessible(root), `SDK path: ${root}`, `Run pixelsentinel devices install --sdk-root '${root}'.`);
  const tools = check("Android command-line tools", "android-sdk", !!commandLineTool("sdkmanager", root) && !!commandLineTool("avdmanager", root),
    "sdkmanager and avdmanager are required for package/AVD management.", "Run pixelsentinel devices install to bootstrap the official command-line tools.");
  const emulator = check("Android Emulator", "android-sdk", await accessible(path.join(root, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator"), constants.X_OK),
    `Emulator binary under ${root}.`, "Run pixelsentinel devices install.");
  check("SDK storage writable", "android-sdk", await accessible(root, constants.W_OK), `SDK storage: ${root}`,
    "Use --sdk-root with a writable SDK directory when installing additional packages.", true);
  const sdkAdb = path.join(root, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  const adbPath = await accessible(sdkAdb, constants.X_OK) ? sdkAdb : adbBinary();
  let adb = false;
  try {
    const result = await exec(adbPath, ["version"], { timeout: 10000 });
    adb = check("Android Debug Bridge (ADB)", "android-sdk", true, `${result.stdout.split("\n")[0]} (${adbPath})`);
  } catch { check("Android Debug Bridge (ADB)", "android-sdk", false, "ADB is not executable.", "Install SDK platform-tools with pixelsentinel devices install."); }
  let images = true, configuredAvds = true;
  for (const profile of profiles) {
    const image = path.join(root, ...profile.systemImage.split(";"));
    images = check(`System image (${profile.id})`, "android-sdk", await accessible(path.join(image, "system.img")),
      profile.systemImage, `Run pixelsentinel devices install --profiles ${profile.id}.`) && images;
    const avd = avdDirectory(profile.avdName, avds);
    let matching = false;
    try {
      const config = await fs.readFile(path.join(avd, "config.ini"), "utf8");
      const imageDir = config.match(/^image.sysdir.1\s*=\s*(.+)$/m)?.[1].trim();
      matching = !!imageDir && path.resolve(root, imageDir) === path.resolve(image);
    } catch { /* Missing/broken AVD is reported below. */ }
    configuredAvds = check(`AVD (${profile.avdName})`, "android-sdk", matching,
      matching ? `${profile.avdName} uses the requested system image.` : `${profile.avdName} is missing or uses another system image.`,
      `Run pixelsentinel devices create ${profile.id}. Existing AVDs are preserved by default.`) && configuredAvds;
  }
  const writableAvds = check("AVD storage writable", "android-sdk", await accessible(avds, constants.W_OK), `AVD directory: ${avds}`,
    "Set ANDROID_AVD_HOME to a writable directory and create the required AVDs.");
  const total = Math.round(os.totalmem() / 1024 ** 3);
  check("System Memory (RAM)", "system", total >= 8, `${total} GiB total; ${Math.floor(os.freemem() / 1024 ** 3)} GiB free.`, "Limit the fleet to one emulator on low-memory hosts.", true);
  const connectedDevices = adb ? (await new AdbClient(adbPath).listDevices()).map(({ serial, state }) => ({ serial, state })) : [];
  return {
    timestamp: new Date().toISOString(), sdkRoot: root, avdHome: avds, checks,
    allPassed: checks.every((c) => c.status === "ok"), canEmulate: acceleration && java && sdk && tools && emulator && adb && images && configuredAvds && writableAvds,
    canUseConnectedDevices: connectedDevices.some((device) => device.state === "device"), connectedDevices
  };
}

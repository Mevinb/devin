import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AndroidBootstrap, type BootstrapOptions, type BootstrapResult } from "./bootstrap.js";

export interface ShellBuildOptions extends BootstrapOptions {
  gradleHome?: string;
  acceptLicenses?: boolean;
}
export interface ShellBuildResult extends BootstrapResult { apkPath?: string; }

/** Build the maintained Kotlin shell; pnpm's browser-only build does not require an SDK. */
export async function buildWebViewShell(options: ShellBuildOptions = {}): Promise<ShellBuildResult> {
  const bootstrap = new AndroidBootstrap(options);
  const dependencies = await bootstrap.install({ profiles: [], runtimeTools: false, acceptLicenses: options.acceptLicenses,
    packages: ["platforms;android-35", "build-tools;35.0.0"] });
  if (!dependencies.success) return dependencies;
  const root = fileURLToPath(new URL("../../android-shell/", import.meta.url));
  const apkPath = path.join(root, "dist/pixelsentinel-shell.apk");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "build.mjs")], {
        env: { ...process.env, ANDROID_HOME: bootstrap.sdkRoot, ANDROID_SDK_ROOT: bootstrap.sdkRoot,
          ANDROID_USER_HOME: bootstrap.userHome, ...(options.gradleHome ? { GRADLE_USER_HOME: path.resolve(options.gradleHome) } : {}) },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let tail = "";
      const receive = (chunk: Buffer) => { const text = chunk.toString(); tail = (tail + text).slice(-4000); options.onLog?.(text.trimEnd()); };
      child.stdout.on("data", receive); child.stderr.on("data", receive);
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("WebView shell build timed out")); }, options.timeoutMs ?? 30 * 60000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`WebView shell build exited ${code}: ${tail}`)); });
    });
    if ((await fs.stat(apkPath)).size < 1000) throw new Error("Build did not produce a valid APK");
    return { success: true, message: `Built and linted WebView shell at ${apkPath}.`, apkPath };
  } catch (error) { return { success: false, message: (error as Error).message }; }
}

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error("Set ANDROID_HOME to an SDK with platforms;android-35 and build-tools;35.0.0, or use pixelsentinel devices build-shell.");
for (const file of ["platforms/android-35/android.jar", "build-tools/35.0.0/source.properties"]) {
  await fs.access(path.join(sdk, file)).catch(() => { throw new Error(`Android build dependency missing: ${file}. Run pixelsentinel devices build-shell with a writable --sdk-root.`); });
}
// Keep Gradle's cache, Android settings and debug signing key out of the user's home.
const cache = process.env.GRADLE_USER_HOME || path.resolve(root, "../../.pixelsentinel/gradle");
const androidHome = process.env.ANDROID_USER_HOME || path.resolve(root, "../../.pixelsentinel/android/user");
await fs.mkdir(cache, { recursive: true });
await fs.mkdir(androidHome, { recursive: true });
const javaHomeState = path.join(cache, "java-home");
await fs.mkdir(javaHomeState, { recursive: true });
const wrapper = path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
// AGP's legacy analytics helper ignores ANDROID_USER_HOME and falls back to JVM user.home.
const args = [`-Duser.home=${javaHomeState}`, "--no-daemon", "--console=plain", "--project-dir", root, "assembleDebug", "lintDebug"];
await new Promise((resolve, reject) => {
  const child = spawn(wrapper, args, { stdio: "inherit", env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
    ANDROID_USER_HOME: androidHome, GRADLE_USER_HOME: cache } });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Android shell build exited ${code}`)));
});
const source = path.join(root, "app/build/outputs/apk/debug/app-debug.apk");
const output = path.join(root, "dist/pixelsentinel-shell.apk");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.copyFile(source, output);
console.log(`Built and linted WebView shell: ${output}`);

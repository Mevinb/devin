import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
const exec = promisify(execFile);
const root = path.resolve(__dirname, "../../..");

describe("Device management commands", () => {
  let temp: string, sdk: string, avds: string;
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-device-cli-"));
    sdk = path.join(temp, "SDK 'quoted'"); avds = path.join(temp, "avds");
  });
  afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
  async function run(args: string[]) {
    try { return { ...(await exec(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "packages/cli/src/bin.ts"), "devices", ...args], {
      cwd: temp, timeout: 20000, env: { ...process.env, OPENAI_API_KEY: "", ANDROID_HOME: sdk, ANDROID_AVD_HOME: avds, ANDROID_USER_HOME: path.join(temp, "user") }
    })), code: 0 }; }
    catch (error) { const result = error as Error & { stdout: string; stderr: string; code: number }; if (typeof result.code !== "number") throw error; return result; }
  }
  async function installedFixture() {
    const bin = path.join(sdk, "cmdline-tools/latest/bin"); await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "sdkmanager"), "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
    await fs.writeFile(path.join(bin, "avdmanager"), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1],dir=get('--path');
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'config.ini'),'image.sysdir.1='+get('--package').replaceAll(';','/')+'/\\nhw.device.name='+get('--device')+'\\nhw.keyboard=yes\\n');
fs.writeFileSync(path.join(process.env.ANDROID_AVD_HOME,get('--name')+'.ini'),'path='+dir+'\\n');
`, { mode: 0o755 });
    for (const file of ["platform-tools/adb", "emulator/emulator", "system-images/android-35/google_apis_playstore/x86_64/system.img"]) {
      await fs.mkdir(path.dirname(path.join(sdk, file)), { recursive: true }); await fs.writeFile(path.join(sdk, file), "installed");
    }
  }
  it("returns a nonzero doctor status and actionable JSON on a machine without the SDK", async () => {
    const result = await run(["doctor", "--json"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.canEmulate).toBe(false); expect(report.sdkRoot).toBe(sdk);
    expect(report.checks.some((check: { status: string; recommendation?: string }) => check.status === "error" && check.recommendation)).toBe(true);
    expect(result.stdout).not.toContain("fully capable");
  });
  it("wires install/create to the selected SDK and preserves an existing AVD", async () => {
    await installedFixture();
    const installed = await run(["install", "--profiles", "pixel_8"]);
    expect(installed.code, installed.stderr).toBe(0); expect(installed.stdout).toContain("existing packages were preserved");
    const created = await run(["create", "android:pixel-8"]);
    expect(created.code, created.stdout + created.stderr).toBe(0);
    const file = path.join(avds, "ps_phone.avd/config.ini"); const config = await fs.readFile(file, "utf8");
    expect(config).toContain("hw.lcd.width=1080"); expect(config).toContain("hw.keyboard=no");
    const refused = await run(["create", "pixel_8"]);
    expect(refused.code).toBe(1); expect(refused.stdout).toContain("preserved"); expect(await fs.readFile(file, "utf8")).toBe(config);
  }, 20000);
  it("rejects unknown profiles without downloading tools or modifying the SDK", async () => {
    for (const id of ["unknown-profile", "constructor", "__proto__"]) {
      const result = await run(["install", "--profiles", id]);
      expect(result.code).toBe(1); expect(result.stdout).toContain("Unknown AVD profile");
    }
    await expect(fs.access(sdk)).rejects.toThrow();
  }, 20000);
});

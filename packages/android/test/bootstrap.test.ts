import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AndroidBootstrap } from "../src/bootstrap.js";
import { getAvdProfile, listAvdProfiles } from "../src/profiles.js";

const exec = promisify(execFile);
const installer = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const args=process.argv.slice(2), root=process.env.ANDROID_HOME;
fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify({args,avds:process.env.ANDROID_AVD_HOME})+'\\n');
if(args.includes('--install')) for(const id of args.slice(args.indexOf('--install')+1)) {
 const dir=path.join(root,...id.split(';')); fs.mkdirSync(dir,{recursive:true});
 const file=id==='emulator'?'emulator':id==='platform-tools'?'adb':id.startsWith('system-images;')?'system.img':'package.xml';
 fs.writeFileSync(path.join(dir,file),'installed');
}
`;
const avdmanager = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), value=k=>args[args.indexOf(k)+1], dir=value('--path'), name=value('--name');
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'config.ini'),'image.sysdir.1='+value('--package').replaceAll(';','/')+'/\\nhw.device.name='+value('--device')+'\\nhw.keyboard=yes\\n');
fs.writeFileSync(path.join(process.env.ANDROID_AVD_HOME,name+'.ini'),'path='+dir+'\\n');
fs.appendFileSync(path.join(process.env.ANDROID_HOME,'commands.jsonl'),JSON.stringify({args})+'\\n');
`;

describe("Android SDK bootstrap and AVD creation", () => {
  let temp: string, sdk: string, avds: string;
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-bootstrap-"));
    sdk = path.join(temp, "SDK 'with spaces'"); avds = path.join(temp, "devices");
  });
  afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
  const bootstrap = () => new AndroidBootstrap({ sdkRoot: sdk, avdHome: avds, userHome: path.join(temp, "user") });
  async function fakeTools() {
    const bin = path.join(sdk, "cmdline-tools", "latest", "bin"); await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "sdkmanager"), installer, { mode: 0o755 });
    await fs.writeFile(path.join(bin, "avdmanager"), avdmanager, { mode: 0o755 });
  }
  it("installs exact package arguments in SDK paths with quotes/spaces and preserves installed packages", async () => {
    await fakeTools();
    const first = await bootstrap().install({ profiles: ["pixel_8", "pixel_tablet"] });
    expect(first.success, first.message).toBe(true);
    const commands = await fs.readFile(path.join(sdk, "commands.jsonl"), "utf8");
    const command = JSON.parse(commands.trim());
    expect(command.args).toContain(`--sdk_root=${sdk}`);
    expect(command.args.filter((arg: string) => arg.startsWith("system-images;"))).toEqual(["system-images;android-35;google_apis_playstore;x86_64"]);
    expect((await bootstrap().install({ profiles: ["pixel_8"] })).success).toBe(true);
    expect(await fs.readFile(path.join(sdk, "commands.jsonl"), "utf8")).toBe(commands);
  });
  it("creates the correct hardware configuration and preserves existing AVDs by default", async () => {
    await fakeTools(); await bootstrap().install({ profiles: ["pixel_8"] });
    const profile = getAvdProfile("pixel_8")!;
    const result = await bootstrap().createAvd(profile);
    expect(result.success, result.message).toBe(true);
    const config = await fs.readFile(path.join(avds, "ps_phone.avd", "config.ini"), "utf8");
    for (const line of ["hw.lcd.width=1080", "hw.lcd.height=2400", "hw.lcd.density=420", "hw.keyboard=no", "hw.ramSize=4096"]) expect(config).toContain(line);
    const again = await bootstrap().createAvd(profile);
    expect(again.success).toBe(false); expect(again.message).toContain("preserved");
    expect(await fs.readFile(path.join(avds, "ps_phone.avd", "config.ini"), "utf8")).toBe(config);
    expect((await bootstrap().createAvd(profile, "../escape")).success).toBe(false);
  });
  it("does not call a zero-exit installer successful when its package payload is missing", async () => {
    await fakeTools(); await fs.writeFile(path.join(sdk, "cmdline-tools/latest/bin/sdkmanager"), "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
    const result = await bootstrap().install({ profiles: ["pixel_8"] });
    expect(result.success).toBe(false); expect(result.message).toContain("incomplete/missing");
  });
  it("installs shell build dependencies without emulator images and honors an isolated Android user home", async () => {
    await fakeTools();
    const userHome = path.join(temp, "isolated user");
    const result = await new AndroidBootstrap({ sdkRoot: sdk, userHome }).install({ profiles: [], runtimeTools: false,
      packages: ["platforms;android-35", "build-tools;35.0.0"] });
    expect(result.success, result.message).toBe(true);
    const command = JSON.parse((await fs.readFile(path.join(sdk, "commands.jsonl"), "utf8")).trim());
    expect(command.args.slice(command.args.indexOf("--install") + 1)).toEqual(["platforms;android-35", "build-tools;35.0.0"]);
    expect(command.avds).toBe(path.join(userHome, "avd"));
  });
  it("uses distinct runtime-compatible AVD names and Chrome-bearing images for browser profiles", () => {
    const profiles = listAvdProfiles(); expect(new Set(profiles.map((p) => p.avdName)).size).toBe(profiles.length);
    for (const profile of profiles.filter((p) => ["phone", "tablet", "foldable"].includes(p.deviceType))) expect(profile.systemImage).toContain("google_apis_playstore");
    expect(getAvdProfile("android:pixel-fold")?.id).toBe("pixel_fold");
    expect(getAvdProfile("phone")?.avdName).toBe("ps_phone");
  });
  it("downloads and verifies tools before extraction and rejects a bad checksum without installing anything", async () => {
    const archive = path.join(temp, "tools.zip");
    await exec("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('cmdline-tools/bin/sdkmanager',sys.argv[2]); z.writestr('cmdline-tools/bin/avdmanager',sys.argv[3]); z.close()", archive, installer, avdmanager]);
    const bytes = await fs.readFile(archive), digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const server = http.createServer((_req, response) => { response.end(bytes); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/tools.zip`;
    try {
      const wrong = await new AndroidBootstrap({ sdkRoot: sdk, toolsDownload: { url, sha256: "0".repeat(64) } }).ensureCommandLineTools();
      expect(wrong.success).toBe(false); expect(wrong.message).toContain("checksum mismatch");
      expect(await fs.readdir(path.join(sdk, "cmdline-tools"))).toEqual([]);
      const correct = await new AndroidBootstrap({ sdkRoot: sdk, toolsDownload: { url, sha256: digest } }).ensureCommandLineTools();
      expect(correct.success, correct.message).toBe(true);
      expect(await fs.readFile(path.join(sdk, "cmdline-tools/latest/bin/sdkmanager"), "utf8")).toBe(installer);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = path.resolve(__dirname, "../../..");
const fixture = (name: string) => path.join(root, "fixtures", name);

describe("CLI scan and exploration contracts", () => {
  let temp: string;
  beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-cli-")); });
  afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
  async function run(args: string[]) {
    try {
      const result = await exec(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "packages/cli/src/bin.ts"), ...args], {
        cwd: temp, timeout: 25000, env: { ...process.env, OPENAI_API_KEY: "", PIXELSENTINEL_DEVICES: "approximate" }
      });
      return { ...result, code: 0 };
    } catch (err) {
      const result = err as Error & { stdout: string; stderr: string; code: number };
      if (typeof result.code !== "number") throw err;
      return result;
    }
  }
  const report = async (dir: string) => JSON.parse(await fs.readFile(path.join(dir, "report.json"), "utf8"));

  it("honors --devices instead of running the default eleven viewport matrix and fails CI on critical defects", async () => {
    const project = path.join(temp, "project"), results = path.join(temp, "results");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><div style="width:3000px;height:50px">Overflow</div></body></html>');
    const result = await run(["scan", project, "--devices", "chromium:desktop-1080p", "--no-vision", "--out", results]);
    expect(result.code, result.stderr).toBe(1);
    const data = await report(results);
    expect(data.matrix).toHaveLength(1);
    expect(data.matrix[0].device.id).toBe("chromium:desktop-1080p");
    expect(data.summary.criticalFindings).toBeGreaterThan(0);
  }, 30000);

  it("respects approximation thresholds and --fail-on none", async () => {
    const out = path.join(temp, "results");
    const args = ["scan", fixture("overflow-horizontal"), "--devices", "webkit:iphone-se", "--no-vision", "--out", out];
    expect((await run(args)).code).toBe(0);
    const data = await report(out);
    expect(data.summary.criticalFindings).toBeGreaterThan(0);
    expect(data.matrix[0].device.fidelity).toBe("approximate");
    expect((await run([...args, "--fail-on-approximate"])).code).toBe(1);
    expect((await run([...args, "--fail-on-approximate", "--fail-on", "none"])).code).toBe(0);
  }, 30000);

  it("explores and replays saved states through commands that exit cleanly", async () => {
    const discovered = path.join(temp, "discovered"), replayed = path.join(temp, "replayed");
    const result = await run(["explore", fixture("flows"), "--devices", "chromium:desktop-1080p", "--mock-agent",
      "--max-steps", "2", "--no-vision", "--fail-on", "none", "--out", discovered]);
    expect(result.code, result.stderr).toBe(0);
    const data = await report(discovered);
    expect(data.mode).toBe("explore");
    expect(data.summary.statesDiscovered).toBeGreaterThan(1);
    expect(data.matrix.every((item: { device: { id: string } }) => item.device.id === "chromium:desktop-1080p")).toBe(true);
    const replay = await run(["replay", path.join(discovered, "explore", "trace.json"), "--target", fixture("flows"),
      "--devices", "chromium:desktop-1080p", "--mock-agent", "--no-vision", "--out", replayed]);
    expect(replay.code, replay.stderr).toBe(0);
    expect((await report(replayed)).matrix.length).toBe(data.matrix.length);
  }, 30000);

  it("honors custom config defaults and rejects invalid failure thresholds", async () => {
    await fs.writeFile(path.join(temp, "pixelsentinel.config.json"), JSON.stringify({
      devices: ["chromium:desktop-1080p"], output: { dir: path.join(temp, "configured") }, vision: { enabled: false, model: "configured-model" }
    }));
    const result = await run(["scan", fixture("clean")]);
    expect(result.code, result.stderr).toBe(0);
    const data = await report(path.join(temp, "configured"));
    expect(data.config.vision.model).toBe("configured-model");
    expect(data.config.vision.enabled).toBe(false);
    expect(data.matrix).toHaveLength(1);
    expect((await run(["scan", fixture("clean"), "--fail-on", "typo"])).code).not.toBe(0);
  }, 30000);
  it("fails replay CI on a missing step even when finding-based failures are disabled", async () => {
    const project = path.join(temp, "project"), out = path.join(temp, "replayed"), trace = path.join(temp, "trace.json");
    await fs.mkdir(project); await fs.writeFile(path.join(project, "index.html"), "<h1>Home</h1>");
    await fs.writeFile(trace, JSON.stringify({ traceId: "broken", startTime: "now", endTime: "now",
      pilotTarget: { id: "desktop", name: "Desktop", runtime: "playwright", viewport: { width: 1280, height: 800 } },
      discoveredStates: [{ stateId: "home", name: "Home", fingerprint: "old", url: "http://127.0.0.1:1/" }],
      steps: [{ stepIndex: 0, action: { type: "tap", selector: "#missing" }, stateBefore: "home", stateAfter: "home", timestamp: "now" }] }));
    const result = await run(["replay", trace, "--target", project, "--devices", "chromium:desktop-1080p", "--mock-agent", "--no-vision", "--fail-on", "none", "--out", out]);
    expect(result.code, result.stderr).toBe(1);
    expect((await report(out)).errors[0].message).toContain("Replay diverged at step 0");
  }, 30000);
  it("shares explicit caps, preserves configured pricing, and fails a partial run even with fail-on none", async () => {
    const out = path.join(temp, "budget");
    // Illustrative fixture prices and ceiling; model calls remain disabled.
    await fs.writeFile(path.join(temp, "pixelsentinel.config.json"), JSON.stringify({ budget: { maxMinutes: 10, maxTokens: 10000,
      models: { "gpt-4o": { contextTokens: 100000, inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } }));
    const result = await run(["explore", fixture("flows"), "--devices", "chromium:desktop-1080p", "--mock-agent", "--no-vision", "--max-actions", "0", "--fail-on", "none", "--out", out]);
    expect(result.code, result.stderr).toBe(1);
    const data = await report(out);
    expect(data.matrix).toHaveLength(1);
    expect(data.usage).toMatchObject({ requests: 0, actions: 0, stopped: { kind: "actions" }, limits: { maxMinutes: 10, maxTokens: 10000,
      models: { "gpt-4o": { contextTokens: 100000, inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } });
    expect((await run(["scan", fixture("clean"), "--max-cost", "NaN"])).code).not.toBe(0);
  }, 30000);
});

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { replayTrace } from "../src/explore/run.js";
import { parseReplayTrace } from "../src/explore/trace.js";
import { BUILTIN_DEVICES } from "../src/runtime/registry.js";
import { reportFails } from "../src/scanner.js";
import type { ReplayableTrace } from "../src/explore/types.js";

describe("Saved replay contracts", () => {
  let server: http.Server, origin: string, temp: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<h1>${req.url === "/next" ? "Next" : "Home"}</h1><button id="noop">No change</button>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-replay-")); });
  afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
  const old = "http://127.0.0.1:1"; // intentionally unavailable: replay must use its new server
  const trace = (): ReplayableTrace => ({ traceId: "saved", pilotTarget: BUILTIN_DEVICES["chromium:desktop-1080p"], startUrl: old + "/",
    startTime: "2026-10-25T00:00:00Z", endTime: "2026-10-25T00:00:01Z",
    discoveredStates: [{ stateId: "home", name: "Home", fingerprint: "old-home", url: old + "/" }, { stateId: "next", name: "Next", fingerprint: "old-next", url: old + "/next" }],
    steps: [{ stepIndex: 0, action: { type: "navigate", url: old + "/next" }, stateBefore: "home", stateAfter: "next", timestamp: "now" },
      { stepIndex: 1, action: { type: "done", reason: "complete" }, stateBefore: "next", stateAfter: "next", timestamp: "now" }] });
  async function run(input: ReplayableTrace) {
    const file = path.join(temp, "trace.json"); await fs.writeFile(file, JSON.stringify(input));
    return replayTrace(file, { target: origin, devices: ["chromium:desktop-1080p"], extraWaitMs: 0,
      vision: { enabled: false }, output: { dir: path.join(temp, "out") } }, { useMockAgent: true, maxRecoverySteps: 0 });
  }

  it("rebases absolute navigation to a new server and retains state names and zero recovery calls", async () => {
    const result = await run(trace());
    expect(result.errors).toBeUndefined(); expect(result.matrix.map((item) => item.stateName)).toEqual(["Home", "Next"]);
    const meta = JSON.parse(await fs.readFile(path.join(temp, "out/renders/chromium_desktop-1080p__next/meta.json"), "utf8"));
    expect(meta.url).toBe(origin + "/next"); expect(result.summary.agentCalls).toBe(0);
  });
  it("persists replay divergence as an error that fails CI even with finding thresholds disabled", async () => {
    const input = trace(); input.steps[0].action = { type: "tap", selector: "#missing" };
    const result = await run(input);
    expect(result.errors?.[0]).toMatchObject({ targetId: "chromium:desktop-1080p" });
    expect(result.errors![0].message).toContain("step 0"); expect(reportFails(result, "none")).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(temp, "out/report.json"), "utf8")).errors).toEqual(result.errors);
  });
  it("does not label a different state successful merely because clicking returned successfully", async () => {
    const input = trace(); input.steps[0].action = { type: "tap", selector: "#noop" };
    const result = await run(input);
    expect(result.errors![0].message).toContain("did not reach the recorded state");
    expect(result.matrix.map((item) => item.stateName)).toEqual(["Home"]);
  });
  it("rejects malformed actions, dangling state references and duplicate IDs before launching", () => {
    const badAction = trace(); badAction.steps[0].action = { type: "navigate" } as never;
    expect(() => parseReplayTrace(badAction)).toThrow();
    const dangling = trace(); dangling.steps[0].stateAfter = "unknown";
    expect(() => parseReplayTrace(dangling)).toThrow(/state reference/);
    const duplicate = trace(); duplicate.discoveredStates.push(duplicate.discoveredStates[0]);
    expect(() => parseReplayTrace(duplicate)).toThrow(/duplicate state IDs/);
  });
});

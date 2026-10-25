import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ScanJob } from "../src/index.js";

const root = path.resolve(__dirname, "../../..");
const fixture = (name: string) => path.join(root, "fixtures", name);
const exec = promisify(execFile);

describe("Dashboard job API", () => {
  let temp: string;
  let server: ReturnType<typeof createServer>;
  beforeEach(async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("PIXELSENTINEL_DEVICES", "approximate");
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-server-"));
    server = createServer({ outputDir: path.join(temp, "artifacts"), logger: false });
    await server.ready();
  });
  afterEach(async () => { await server.close(); await fs.rm(temp, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  async function submit(body: Record<string, unknown>) {
    return server.inject({ method: "POST", url: "/api/scans", payload: body });
  }
  async function finished(id: string): Promise<ScanJob> {
    let final: ScanJob | undefined;
    await vi.waitFor(async () => {
      final = (await server.inject(`/api/scans/${id}`)).json();
      expect(["completed", "failed"]).toContain(final!.status);
    }, { timeout: 20000, interval: 100 });
    return final!;
  }

  it("validates scan and exploration input before accepting jobs", async () => {
    for (const payload of [ {}, { target: "" }, { target: fixture("clean"), devices: ["missing:device"] },
      { target: fixture("clean"), explore: true, exploreConfig: { maxSteps: -1 } },
      { target: fixture("clean"), budget: { maxCostUsd: -1 } },
      { target: fixture("clean"), budget: { models: { test: { contextTokens: 100, inputUsdPerMillion: 1 } } } },
      { target: fixture("clean"), vision: { enabled: "yes" } }, { target: fixture("clean"), proposeFixes: "yes" } ]) {
      expect((await submit(payload)).statusCode).toBe(400);
    }
    expect((await server.inject("/api/scans")).json()).toHaveLength(0);
    expect((await server.inject("/api/scans/missing/events")).statusCode).toBe(404);
  });

  it("persists partial budget-stopped jobs and streams shared usage without reporting a clean scan", async () => {
    const created = (await submit({ target: fixture("flows"), devices: ["chromium:desktop-1080p"], vision: { enabled: false }, extraWaitMs: 0,
      explore: true, exploreConfig: { maxSteps: 3, maxStates: 3, useMockAgent: true }, budget: { maxActions: 0, maxCostUsd: 0 } })).json();
    const job = await finished(created.jobId);
    expect(job.status, job.error).toBe("completed");
    expect(job.report!.matrix).toHaveLength(1);
    expect(job.report!.errors?.some((error) => error.targetId === "budget")).toBe(true);
    expect(job.usage.budget).toMatchObject({ requests: 0, actions: 0, costUsd: 0, stopped: { kind: "actions" } });
    const stream = await server.inject(`/api/scans/${job.id}/events`);
    expect(stream.body).toContain("event: usage"); expect(stream.body).toContain("Reached the shared action budget");
    const report = (await server.inject(job.artifactBaseUrl + "report.json")).json();
    expect(report.usage.stopped.kind).toBe("actions");
    expect(report.matrix[0].screenshotRelPath).toBeTruthy();
  });

  it("queues jobs and retains separate reports and image artifacts", async () => {
    const body = { devices: ["chromium:desktop-1080p"], vision: { enabled: false }, extraWaitMs: 0 };
    const first = (await submit({ ...body, target: fixture("overlap") })).json();
    const second = (await submit({ ...body, target: fixture("clean") })).json();
    expect(first.jobId).not.toBe(second.jobId);
    expect((await server.inject(`/api/scans/${second.jobId}`)).json().status).toBe("queued");
    const [a, b] = await Promise.all([finished(first.jobId), finished(second.jobId)]);
    expect(a.status, a.error).toBe("completed"); expect(b.status, b.error).toBe("completed");
    expect(a.report!.matrix).toHaveLength(1); expect(b.report!.summary.totalFindings).toBe(0);
    expect(a.report!.summary.totalFindings).toBeGreaterThan(0);
    for (const job of [a, b]) {
      expect((await server.inject(job.artifactBaseUrl + "report.json")).statusCode).toBe(200);
      const image = await server.inject(job.artifactBaseUrl + job.report!.matrix[0].annotatedRelPath);
      expect(image.headers["content-type"]).toContain("image/png");
      expect(image.rawPayload.length).toBeGreaterThan(500);
      expect(Object.values(job.fleet).every((device) => device.phase === "released")).toBe(true);
    }
    expect((await server.inject("/api/scans")).json()).toHaveLength(2);
  }, 30000);

  it("honors exploration devices and streams real agent actions, screenshots and completion", async () => {
    const url = await server.listen({ port: 0, host: "127.0.0.1" });
    const result = (await submit({ target: fixture("flows"), devices: ["chromium:desktop-1080p"],
      explore: true, exploreConfig: { useMockAgent: true, maxSteps: 2, maxStates: 4 }, vision: { enabled: false }, extraWaitMs: 0 })).json();
    const response = await fetch(`${url}/api/scans/${result.jobId}/events`, { signal: AbortSignal.timeout(20000) });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let stream = "";
    const first = await reader.read(); stream += decoder.decode(first.value);
    expect(stream).toContain("event: snapshot");
    expect(stream).not.toContain('"status":"completed"');
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      stream += decoder.decode(chunk.value, { stream: true });
    }
    expect(stream).toContain("event: agent"); expect(stream).toContain('"type":"tap"');
    expect(stream).toContain('"screenshotPath":"renders/'); expect(stream).toContain('"status":"completed"');
    const job = await finished(result.jobId);
    expect(job.report!.mode).toBe("explore");
    expect(job.report!.summary.statesDiscovered).toBeGreaterThan(1);
    expect(job.report!.matrix.every((item) => item.device?.id === "chromium:desktop-1080p")).toBe(true);
    expect(job.report!.matrix.every((item) => item.stateName && item.annotatedRelPath.endsWith("annotated.png"))).toBe(true);
    expect(job.usage).toMatchObject({ agentCalls: 0, agentTokens: 0, budget: { requests: 0, totalTokens: 0, costUsd: 0 } });
    const lastEventId = job.events.at(-2)!.id;
    const resumed = await fetch(`${url}/api/scans/${job.id}/events`, { headers: { "Last-Event-ID": String(lastEventId) } });
    const resumedText = await resumed.text();
    const ids = [...resumedText.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids.every((id) => id > lastEventId)).toBe(true);
  }, 30000);

  it("serves the actual verified patch for its job and leaves the target source unchanged", async () => {
    const project = path.join(temp, "project"); await fs.mkdir(project);
    const source = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0} #wide {width:3000px;height:50px}</style></head><body><div id="wide">Overflow</div></body></html>\n';
    await fs.writeFile(path.join(project, "index.html"), source);
    await exec("git", ["init", "-q", project]); await exec("git", ["add", "."], { cwd: project });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: project });
    const result = (await submit({ target: project, devices: ["chromium:desktop-1080p"], vision: { enabled: false },
      extraWaitMs: 0, proposeFixes: true })).json();
    const job = await finished(result.jobId);
    expect(job.status, job.error).toBe("completed");
    const fixes = (await server.inject(`/api/scans/${job.id}/fixes`)).json();
    expect(fixes).toHaveLength(1); expect(fixes[0].verificationStatus, fixes[0].verificationMessage).toBe("verified");
    expect(fixes[0].diff).toContain("a/index.html");
    expect((await server.inject(job.artifactBaseUrl + fixes[0].diffRelPath)).body).toBe(fixes[0].diff);
    expect((await server.inject(job.artifactBaseUrl + fixes[0].verifications[0].afterScreenshotRelPath)).statusCode).toBe(200);
    expect((await server.inject(`/api/fixes?scanId=${job.id}`)).json()).toEqual(fixes);
    expect(await fs.readFile(path.join(project, "index.html"), "utf8")).toBe(source);
    expect((await exec("git", ["status", "--porcelain"], { cwd: project })).stdout).toBe("");
  }, 30000);
});

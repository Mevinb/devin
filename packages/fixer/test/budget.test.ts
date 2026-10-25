import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ExplorationAgent, OpenAIProvider, RunBudget, ScanConfigSchema, type DOMSnapshot } from "@pixelsentinel/core";
import { PatchGenerator } from "../src/generator.js";
import { FixProposalEngine } from "../src/index.js";
import { scan } from "@pixelsentinel/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: request } }; } }));
afterEach(() => { vi.unstubAllEnvs(); request.mockReset(); });
it("meters agent, recovery, vision and fixer against one cap without making a live API request", async () => {
  vi.stubEnv("OPENAI_API_KEY", "offline-sdk-test");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-sdk-budget-"));
  const budget = new RunBudget({ maxTokens: 100000, maxCostUsd: 1,
    models: { "gpt-4o": { contextTokens: 10000, inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } });
  request.mockImplementation(async (payload) => ({
    usage: { prompt_tokens: 9000, completion_tokens: 200, total_tokens: 9200 },
    choices: [{ finish_reason: "stop", message: payload.response_format?.type === "json_schema" ? { content: '{"findings":[]}' }
      : payload.response_format?.type === "json_object" ? { content: JSON.stringify({ explanation: "Offline fixture", diff: "diff --git a/style.css b/style.css\n--- a/style.css\n+++ b/style.css\n@@ -1 +1 @@\n-#wide{width:750px}\n+#wide{width:100%}" }) }
      : { tool_calls: [{ type: "function", function: { name: "done", arguments: '{"reason":"Offline fixture"}' } }] } }]
  }));
  const snapshot: DOMSnapshot = { elements: [], document: { innerWidth: 400, innerHeight: 300, scrollWidth: 400, scrollHeight: 300, devicePixelRatio: 1 } };
  try {
    const agent = new ExplorationAgent({}, budget);
    await agent.decideNextAction(snapshot, "", "https://fixture.invalid", "home");
    await agent.decideNextAction(snapshot, "", "https://fixture.invalid", "home", { goal: "Recover details" });
    const provider = new OpenAIProvider({ apiKey: "offline-sdk-test", budget, cacheDir: path.join(temp, "cache") });
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    const context = { domSnapshot: snapshot, imageWidth: 400, imageHeight: 300,
      renderConfig: { ...ScanConfigSchema.parse({ target: "https://fixture.invalid", viewports: [{ name: "Test", width: 400, height: 300 }] }).viewports![0], renderId: "test" } };
    await provider.analyze(image, context); await provider.analyze(image, context);
    await new PatchGenerator("offline-sdk-test", "gpt-4o", temp, budget).generatePatch({ id: "finding", type: "horizontal-overflow", severity: "critical", confidence: 1,
      sources: ["heuristic"], elements: [{ selector: "#wide" }], bbox: { x: 0, y: 0, left: 0, top: 0, width: 750, height: 40, right: 750, bottom: 40 }, renderId: "test", description: "Overflow" },
    { file: "style.css", line: 1, confidence: 1, method: "grep-fallback", snippet: "#wide{width:750px}" });
    const usage = budget.snapshot();
    expect(usage.requests).toBe(4); expect(usage.totalTokens).toBe(36800); expect(usage.costUsd).toBeCloseTo(0.0376, 8);
    for (const phase of ["agent", "recovery", "vision", "fixer"] as const) expect(usage.phases[phase]).toMatchObject({ requests: 1, promptTokens: 9000, completionTokens: 200 });
    expect(usage.phases.vision.cacheHits).toBe(1);
    budget.constrain({ maxTokens: 37000 });
    await expect(agent.decideNextAction(snapshot, "", "https://fixture.invalid", "another")).rejects.toThrow(/token budget/i);
    expect(request).toHaveBeenCalledTimes(4);
  } finally { budget.dispose(); await fs.rm(temp, { recursive: true, force: true }); }
});

it("retains an unverified patch when AFTER vision hits the cap for a heuristic-only finding", async () => {
  vi.stubEnv("OPENAI_API_KEY", "offline-sdk-test");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-verification-cap-")), repo = path.join(temp, "project");
  await fs.mkdir(repo);
  const source = '<meta name="viewport" content="width=device-width"><style>#wide{width:750px;height:40px}</style><div id="wide">Overflow</div>';
  await fs.writeFile(path.join(repo, "index.html"), source);
  const exec = promisify(execFile); await exec("git", ["init", "-q", repo]); await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: repo });
  const config = { target: repo, viewports: [{ name: "Phone fixture", width: 390, height: 844 }], vision: { enabled: false, cacheDir: path.join(temp, "cache") }, extraWaitMs: 0, output: { dir: path.join(temp, "out") } };
  const budget = new RunBudget({ maxTokens: 2100, models: { "gpt-4o": { contextTokens: 100 } } });
  try {
    const report = await scan(config), finding = report.matrix[0].findings.find((item) => item.type === "horizontal-overflow")!;
    expect(finding.sources).toEqual(["heuristic"]);
    request.mockResolvedValue({ usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, choices: [{ finish_reason: "stop", message: { content: '{"findings":[]}' } }] });
    const proposals = await new FixProposalEngine({ repoRoot: repo, apiKey: "", budget, scanConfig: { ...config, vision: { ...config.vision, enabled: true } } }).proposeFixes([finding], config.output.dir);
    expect(request).toHaveBeenCalledTimes(1); expect(budget.snapshot().stopped?.kind).toBe("tokens");
    expect(proposals).toHaveLength(1); expect(proposals[0].verificationStatus).toBe("unverified");
    expect(proposals[0].verificationMessage).toContain("Verification stopped");
    await fs.access(proposals[0].beforeScreenshotPath!); await fs.access(proposals[0].verifiedScreenshotPath!);
    expect(proposals[0].verifications![0].status).toBe("unverified");
    expect(await fs.readFile(path.join(repo, "index.html"), "utf8")).toBe(source);
  } finally { budget.dispose(); await fs.rm(temp, { recursive: true, force: true }); }
}, 15000);

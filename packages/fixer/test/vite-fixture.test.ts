import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analyzeCapture, attachPageMonitor, captureCurrentState, DeviceRegistry, executeAction, explore, MockVisionProvider,
  resolveTarget, ScanConfigSchema, snapshotPage, type Finding, type ScanConfigInput } from "@pixelsentinel/core";
import { CdpCssResolver, FixProposalEngine, SourceMapResolver, WorktreeManager } from "../src/index.js";

const exec = promisify(execFile);
const root = path.resolve(__dirname, "../../..");
const fixture = path.join(root, "fixtures/flows");
describe("Actual React/Vite flow fixture", () => {
  let temp: string, repo: string, out: string, config: ScanConfigInput, finding: Finding;
  beforeAll(async () => {
    vi.stubEnv("PIXELSENTINEL_DEVICES", "approximate"); vi.stubEnv("OPENAI_API_KEY", "");
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-vite-fixture-")); repo = path.join(temp, "source 'quoted'"); out = path.join(temp, "out");
    await fs.cp(fixture, repo, { recursive: true, filter: (file) => !path.relative(fixture, file).split(path.sep).some((part) => ["node_modules", "dist"].includes(part)) });
    await fs.writeFile(path.join(repo, ".gitignore"), "node_modules\ndist/\n");
    await exec("git", ["init", "-q", repo]); await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "React fixture"], { cwd: repo });
    await fs.symlink(path.join(fixture, "node_modules"), path.join(repo, "node_modules"), "dir");
    config = { target: repo, devices: ["chromium:desktop-1080p"], vision: { enabled: false }, extraWaitMs: 100, output: { dir: out },
      devServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port {port}", port: 0, readyTimeoutMs: 15000 } };
    const discovered = await explore(config, { maxSteps: 4, maxStates: 6, useMockAgent: true });
    const match = discovered.result.allFindings.find((candidate) => candidate.type === "element-overlap" &&
      candidate.elements.some((element) => element.selector === "#productAlpha") && candidate.elements.some((element) => element.selector === "#productBeta"));
    expect(match, "The authored negative margin must produce the real seeded overlap").toBeDefined(); finding = match!;
  }, 30000);
  afterAll(async () => { await fs.rm(temp, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it("maps the causal overlap rule to its authored CSS line through the live dev server", async () => {
    const server = await resolveTarget(ScanConfigSchema.parse(config));
    const cdp = new CdpCssResolver(server.url, repo, [repo]);
    try {
      const location = await new SourceMapResolver(repo, cdp).resolveLocation(finding);
      const css = await fs.readFile(path.join(repo, "src/styles.css"), "utf8");
      expect(location?.file).toBe("src/styles.css");
      expect(location?.line).toBe(css.split("\n").findIndex((line) => line.startsWith("#productBeta")) + 1);
      expect(location?.cssRule?.selectorText).toBe("#productBeta");
      expect(location?.method).toBe("css-sourcemap");
    } finally { await cdp.close(); await server.cleanup(); }
  }, 20000);

  it("emits an applicable overlap diff and verifies the isolated React state without source changes", async () => {
    const before = (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout;
    const css = await fs.readFile(path.join(repo, "src/styles.css"), "utf8");
    const proposals = await new FixProposalEngine({ repoRoot: repo, apiKey: "", scanConfig: config }).proposeFixes([finding], out);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal.file).toBe("src/styles.css");
    expect(proposal.verificationStatus, proposal.verificationMessage).toBe("verified");
    const patch = path.join(out, "patches", `${proposal.id}.diff`);
    await exec("git", ["apply", "--check", patch], { cwd: repo });
    expect(await fs.readFile(path.join(repo, "src/styles.css"), "utf8")).toBe(css);
    expect((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout).toBe(before);
    const evidence = "/tmp/pixelsentinel-qa/vite-fixture"; await fs.mkdir(evidence, { recursive: true });
    await fs.copyFile(proposal.beforeScreenshotPath!, path.join(evidence, "before.png"));
    await fs.copyFile(proposal.verifiedScreenshotPath!, path.join(evidence, "after.png"));
    await fs.copyFile(patch, path.join(evidence, "verified.diff"));
  }, 40000);

  it("maps hashed CSS-module rules back to Sass and verifies a responsive repair", async () => {
    const mobile = ScanConfigSchema.parse({ ...config, devices: ["android:pixel-8"] });
    const server = await resolveTarget(mobile), registry = new DeviceRegistry();
    let tableFinding: Finding;
    try {
      const target = registry.resolveTarget("android:pixel-8");
      const session = await registry.getRuntime(target.runtime).launch(target);
      try {
        const monitor = attachPageMonitor(session.page);
        try {
          await session.page.goto(server.url, { waitUntil: "networkidle" });
          const actions = [{ type: "tap" as const, selector: "#menuToggle" }, { type: "tap" as const, selector: "#tabCheckout" }];
          for (const action of actions) expect((await executeAction(session, action, await snapshotPage(session.page))).success).toBe(true);
          const capture = await captureCurrentState({ session, url: server.url, renderId: "sass-module", renderDir: path.join(out, "sass-source"), fullPage: true, monitor });
          const analyzed = await analyzeCapture(capture, mobile, new MockVisionProvider([]), { actions });
          const overflow = analyzed.findings.find((candidate) => candidate.type === "horizontal-overflow" && candidate.elements.some((element) => element.selector === "#orderTable"));
          expect(overflow).toBeDefined(); tableFinding = overflow!;
        } finally { monitor.detach(); }
      } finally { await session.close(); }
      const cdp = new CdpCssResolver(server.url, repo, [repo]);
      try {
        const location = await new SourceMapResolver(repo, cdp).resolveLocation(tableFinding!);
        expect(location?.file).toBe("src/orders.module.scss"); expect(location?.method).toBe("css-sourcemap");
        expect(location?.cssRule?.startLine).toBe(3);
      } finally { await cdp.close(); }
    } finally { await registry.shutdownAll(); await server.cleanup(); }

    const before = await fs.readFile(path.join(repo, "src/orders.module.scss"), "utf8");
    const proposals = await new FixProposalEngine({ repoRoot: repo, apiKey: "", scanConfig: mobile }).proposeFixes([tableFinding!], out);
    expect(proposals).toHaveLength(1); const proposal = proposals[0];
    expect(proposal.file).toBe("src/orders.module.scss"); expect(proposal.verificationStatus, proposal.verificationMessage).toBe("verified");
    await exec("git", ["apply", "--check", path.join(out, "patches", `${proposal.id}.diff`)], { cwd: repo });
    expect(await fs.readFile(path.join(repo, "src/orders.module.scss"), "utf8")).toBe(before);
    expect((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout).toBe("");
    const evidence = "/tmp/pixelsentinel-qa/vite-fixture"; await fs.mkdir(evidence, { recursive: true });
    await fs.copyFile(proposal.beforeScreenshotPath!, path.join(evidence, "sass-before.png"));
    await fs.copyFile(proposal.verifiedScreenshotPath!, path.join(evidence, "sass-after.png"));
    await fs.writeFile(path.join(evidence, "sass-verified.diff"), proposal.diff);
    const worktree = await new WorktreeManager(repo).createWorktree();
    try {
      expect((await worktree.applyPatch(proposal.diff)).success).toBe(true);
      await fs.symlink(path.join(fixture, "node_modules"), path.join(worktree.worktreePath, "node_modules"), "dir");
      const server = await resolveTarget(ScanConfigSchema.parse({ ...mobile, target: worktree.worktreePath }));
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
        await page.goto(server.url); await page.click("#menuToggle"); await page.click("#tabCheckout");
        const layout = await page.locator("#orderTable").evaluate((table) => {
          const el = table as HTMLElement, quantity = el.querySelector("th:nth-child(3)")!;
          const range = document.createRange(); range.selectNodeContents(quantity);
          const wholeWord = range.getClientRects().length === 1;
          el.scrollLeft = el.scrollWidth;
          const bounds = el.getBoundingClientRect(), price = el.querySelector("td:last-child")!.getBoundingClientRect();
          return { wholeWord, pageWidth: document.documentElement.scrollWidth, lastColumnVisible: price.left >= bounds.left && price.right <= bounds.right + 1 };
        });
        expect(layout).toEqual({ wholeWord: true, pageWidth: 412, lastColumnVisible: true });
        await page.screenshot({ path: path.join(evidence, "sass-after-scrolled.png") });
      } finally { await browser.close(); await server.cleanup(); }
    } finally { await worktree.cleanup(); }
  }, 45000);
});

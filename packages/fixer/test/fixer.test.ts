import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunBudget, scan, type Finding, type ScanConfigInput } from "@pixelsentinel/core";
import { FixProposalEngine } from "../src/index.js";
import { PatchGenerator, unifiedDiff } from "../src/generator.js";
import { SourceMapResolver } from "../src/sourcemap.js";
import { PatchVerifier } from "../src/verifier.js";
import { WorktreeManager } from "../src/worktree.js";
import type { PatchProposal } from "../src/types.js";

const exec = promisify(execFile);
const markup = `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body { margin: 0; }
#orderTable { width: 720px; }
button { width: 100px; height: 44px; }
</style></head><body>
<button id="open" onclick="document.querySelector('#panel').hidden = false">Open details</button>
<div id="panel"><table id="orderTable"><tr><td>Widget</td><td>Price</td></tr></table></div>
</body></html>
`;

describe("Source patch generation and browser verification", () => {
  let repo: string;
  let output: string;
  let config: ScanConfigInput;
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "ps-project 'quoted'-"));
    output = await fs.mkdtemp(path.join(os.tmpdir(), "ps-verification-"));
    await exec("git", ["init", "-q", repo]);
    await fs.writeFile(path.join(repo, "index.html"), markup.replace("720px", "600px"));
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: repo });
    // Patches must apply to dirty source, not the committed fixture.
    await fs.writeFile(path.join(repo, "index.html"), markup);
    config = { target: repo, viewports: [{ name: "phone-test", width: 320, height: 568, isMobile: true, hasTouch: true }],
      vision: { enabled: false }, extraWaitMs: 0, output: { dir: output } };
  });
  afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }); await fs.rm(output, { recursive: true, force: true }); });

  async function overflow(): Promise<Finding> {
    const report = await scan(config);
    return report.matrix[0].findings.find((f) => f.type === "horizontal-overflow")!;
  }
  async function proposal(finding: Finding): Promise<PatchProposal> {
    const location = await new SourceMapResolver(repo).resolveLocation(finding);
    expect(location?.cssRule?.selectorText).toBe("#orderTable");
    return new PatchGenerator("", "unused", repo).generatePatch(finding, location!);
  }

  it("maps ID-only selectors to CSS and emits a git-applicable responsive table patch", async () => {
    const finding = await overflow();
    const patch = await proposal(finding);
    const before = await fs.readFile(path.join(repo, "index.html"), "utf8");
    const worktree = await new WorktreeManager(repo).createWorktree();
    try {
      expect((await worktree.applyPatch(patch.diff)).success).toBe(true);
      const patched = await fs.readFile(path.join(worktree.worktreePath, "index.html"), "utf8");
      expect(patched).toContain('<table id="orderTable">');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
        await page.setContent(patched.replace("Widget", "AnExtraordinarilyLongUnbrokenProductIdentifier"));
        const layout = await page.locator("#orderTable").evaluate((table) => {
          const el = table as HTMLElement, first = el.querySelector("td")!;
          const range = document.createRange(); range.selectNodeContents(first);
          const singleLine = range.getClientRects().length === 1;
          el.scrollLeft = el.scrollWidth;
          const last = el.querySelector("td:last-child")!.getBoundingClientRect();
          const bounds = el.getBoundingClientRect();
          return { singleLine, pageWidth: document.documentElement.scrollWidth, scrollable: el.scrollWidth > el.clientWidth,
            lastVisible: last.left >= bounds.left && last.right <= bounds.right + 1 };
        });
        expect(layout).toEqual({ singleLine: true, pageWidth: 320, scrollable: true, lastVisible: true });
      } finally { await browser.close(); }
      expect(await fs.readFile(path.join(repo, "index.html"), "utf8")).toBe(before);
    } finally { await worktree.cleanup(); }
    await expect(fs.access(worktree.worktreePath)).rejects.toThrow();
  });

  it("verifies the rendered fix and retains before/after evidence without source changes", async () => {
    const finding = await overflow();
    const patch = await proposal(finding);
    const beforeStatus = (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout;
    const result = await new PatchVerifier(repo).verifyPatch(patch, { finding, scanConfig: config, outputDir: output });
    expect(result.verificationStatus, result.verificationMessage).toBe("verified");
    await fs.access(result.beforeScreenshotPath!);
    await fs.access(result.verifiedScreenshotPath!);
    expect((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout).toBe(beforeStatus);
    expect(await fs.readFile(path.join(repo, "index.html"), "utf8")).toBe(markup);
  });

  it("rejects a patch that applies but leaves the original overflow", async () => {
    const finding = await overflow();
    const patch = await proposal(finding);
    patch.diff = unifiedDiff("index.html", markup, markup.replace("Widget", "Item"));
    const result = await new PatchVerifier(repo).verifyPatch(patch, { finding, scanConfig: config });
    expect(result.verificationStatus, result.verificationMessage).toBe("failed");
    expect(result.verificationMessage).toContain("remains");
  });

  it("rejects a fix that clears overflow but introduces a tiny interactive control", async () => {
    const finding = await overflow();
    const patch = await proposal(finding);
    const changed = markup.replace("720px", "100%").replace("width: 100px; height: 44px", "width: 2px; height: 2px; overflow: hidden");
    patch.diff = unifiedDiff("index.html", markup, changed);
    const result = await new PatchVerifier(repo).verifyPatch(patch, { finding, scanConfig: config });
    expect(result.verificationStatus, result.verificationMessage).toBe("failed");
    expect(result.verificationMessage).toMatch(/introduced/);
  });

  it("replays actions to reproduce a defect hidden in another application state", async () => {
    const finding = await overflow();
    finding.actions = [{ type: "tap", selector: "#open" }];
    const hidden = markup.replace('<div id="panel">', '<div id="panel" hidden>');
    await fs.writeFile(path.join(repo, "index.html"), hidden);
    const patch = await proposal(finding);
    const result = await new PatchVerifier(repo).verifyPatch(patch, { finding, scanConfig: config });
    expect(result.verificationStatus, result.verificationMessage).toBe("verified");
    expect(await fs.readFile(path.join(repo, "index.html"), "utf8")).toBe(hidden);
  });

  it("never calls an application-only check a verified rendering fix", async () => {
    const patch = await proposal(await overflow());
    const result = await new PatchVerifier(repo).verifyPatch(patch);
    expect(result.verificationStatus).toBe("unverified");
    expect(result.verificationMessage).toContain("no finding");
  });

  it("starts and re-scans a dev server from the copied project on an ephemeral port", async () => {
    await fs.writeFile(path.join(repo, "serve.cjs"), `
      const http = require('node:http'), fs = require('node:fs');
      http.createServer((req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(fs.readFileSync('index.html'));
      }).listen(Number(process.env.PORT), '127.0.0.1');
    `);
    config.devServer = { command: "node serve.cjs", port: 0, readyTimeoutMs: 5000 };
    const finding = await overflow();
    const patch = await proposal(finding);
    const result = await new PatchVerifier(repo).verifyPatch(patch, { finding, scanConfig: config });
    expect(result.verificationStatus, result.verificationMessage).toBe("verified");
    expect(await fs.readFile(path.join(repo, "index.html"), "utf8")).toBe(markup);
  }, 20000);

  it("groups matching root rules across devices and writes reviewable diffs and an index", async () => {
    const finding = await overflow();
    const copy = { ...finding, id: "second-device-finding", renderId: finding.renderId };
    const proposals = await new FixProposalEngine({ repoRoot: repo, apiKey: "", scanConfig: config }).proposeFixes([finding, copy], output);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].findingIds).toEqual([finding.id, copy.id]);
    expect(proposals[0].verificationStatus, proposals[0].verificationMessage).toBe("verified");
    expect(proposals[0].verifications).toHaveLength(2);
    expect(await fs.readFile(path.join(output, "patches", `${proposals[0].id}.diff`), "utf8")).toBe(proposals[0].diff);
    expect(JSON.parse(await fs.readFile(path.join(output, "patches", "index.json"), "utf8"))).toHaveLength(1);
    expect(await fs.readFile(path.join(repo, "index.html"), "utf8")).toBe(markup);
  }, 30000);

  it("mirrors untracked files and deletions and rejects nonexistent patch paths", async () => {
    await fs.writeFile(path.join(repo, "extra.css"), ".new { color: red; }\n");
    const worktree = await new WorktreeManager(repo).createWorktree();
    try {
      expect(path.relative(repo, worktree.worktreePath).startsWith("..")).toBe(true);
      expect(await fs.readFile(path.join(worktree.worktreePath, "extra.css"), "utf8")).toContain("red");
      expect((await worktree.applyPatch(unifiedDiff("extra.css", ".new { color: red; }\n", ".new { color: blue; }\n"))).success).toBe(true);
      const hallucinated = await worktree.applyPatch(unifiedDiff("missing.css", "a\n", "b\n"));
      expect(hallucinated.success).toBe(false);
    } finally { await worktree.cleanup(); }
  });

  it("retains an unverified generated diff when the shared budget stops rendering verification", async () => {
    const finding = await overflow(); finding.actions = [{ type: "tap", selector: "#open" }];
    const budget = new RunBudget({ maxActions: 1 });
    try {
      const proposals = await new FixProposalEngine({ repoRoot: repo, apiKey: "", scanConfig: config, budget }).proposeFixes([finding], output);
      expect(budget.snapshot().stopped?.kind).toBe("actions");
      expect(proposals).toHaveLength(1); expect(proposals[0].verificationStatus).toBe("unverified");
      expect(proposals[0].verificationMessage).toContain("Verification stopped");
      expect(await fs.readFile(path.join(output, "patches", `${proposals[0].id}.diff`), "utf8")).toBe(proposals[0].diff);
      expect(JSON.parse(await fs.readFile(path.join(output, "patches/index.json"), "utf8"))).toHaveLength(1);
      expect(await fs.readFile(path.join(repo, "index.html"), "utf8")).toBe(markup);
    } finally { budget.dispose(); }
  }, 15000);
});

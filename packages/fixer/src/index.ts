import fs from "node:fs/promises";
import path from "node:path";
import { isBudgetError, resolveTarget, RunBudget, ScanConfigSchema, type Finding, type ScanReport, type TargetResolution } from "@pixelsentinel/core";
import { CdpCssResolver } from "./cdp-css.js";
import { PatchGenerator } from "./generator.js";
import { SourceMapResolver } from "./sourcemap.js";
import type { FixerConfig, PatchProposal, SourceLocation } from "./types.js";
import { PatchVerifier } from "./verifier.js";

export * from "./types.js";
export * from "./sourcemap.js";
export * from "./generator.js";
export * from "./worktree.js";
export * from "./verifier.js";
export * from "./css.js";
export * from "./cdp-css.js";
export * from "./sourcemap-decode.js";

/** Keep static HTML, dashboard and CLI on the same saved patch/evidence data. */
export function attachProposalsToReport(report: ScanReport, proposals: PatchProposal[], outputDir: string): void {
  const relative = (file?: string) => file ? path.relative(outputDir, file).split(path.sep).join("/") : undefined;
  report.fixes = proposals.map((p) => ({
    id: p.id, findingIds: p.findingIds ?? [p.findingId], file: p.file,
    verificationStatus: p.verificationStatus, explanation: p.explanation,
    diffRelPath: `patches/${p.id}.diff`, diff: p.diff, verificationMessage: p.verificationMessage,
    verifications: p.verifications?.map((v) => ({
      findingId: v.findingId, targetId: v.targetId, status: v.status, message: v.message,
      beforeScreenshotRelPath: relative(v.beforeScreenshotPath), afterScreenshotRelPath: relative(v.afterScreenshotPath)
    }))
  }));
}

export class FixProposalEngine {
  constructor(private readonly config: FixerConfig) {}

  async proposeFixes(findings: Finding[], outputDir?: string): Promise<PatchProposal[]> {
    const budget = this.config.budget ?? new RunBudget(this.config.scanConfig?.budget);
    const proposals: PatchProposal[] = [];
    const groups = new Map<string, { location: SourceLocation; findings: Finding[] }>();
    let server: TargetResolution | undefined;
    let cdp: CdpCssResolver | undefined;
    const save = async () => {
      if (outputDir) {
        const fixesDir = path.join(outputDir, "fixes");
        const patchesDir = path.join(outputDir, "patches");
        await fs.mkdir(fixesDir, { recursive: true });
        await fs.mkdir(patchesDir, { recursive: true });
        for (const proposal of proposals) await fs.writeFile(path.join(patchesDir, `${proposal.id}.diff`), proposal.diff, "utf8");
        const json = JSON.stringify(proposals, null, 2);
        await fs.writeFile(path.join(fixesDir, "proposals.json"), json, "utf8");
        await fs.writeFile(path.join(patchesDir, "index.json"), json, "utf8");
      }
    };
    let detachAbort: (() => void) | undefined;
    try {
      budget.assertActive();
      let liveUrl = this.config.liveUrl;
      if (!liveUrl && this.config.scanConfig) {
        server = await budget.run(() => resolveTarget(ScanConfigSchema.parse(this.config.scanConfig), undefined, budget.signal), (late) => late.cleanup());
        liveUrl = server.url;
      }
      const projectDirs = this.config.projectDirs ?? (this.config.scanConfig && !/^https?:/.test(this.config.scanConfig.target)
        ? [path.resolve(this.config.scanConfig.target)] : [this.config.repoRoot]);
      if (liveUrl) cdp = new CdpCssResolver(liveUrl, this.config.repoRoot, projectDirs, this.config.scanConfig, budget);
      detachAbort = budget.onAbort(async () => { await cdp?.close(); });
      const resolver = new SourceMapResolver(this.config.repoRoot, cdp, budget);
      const generator = new PatchGenerator(this.config.apiKey, this.config.model, this.config.repoRoot, budget);
      const verifier = new PatchVerifier(this.config.repoRoot);
      for (const finding of findings) {
        budget.assertActive();
        const location = await resolver.resolveLocation(finding);
        if (!location) continue;
        const key = `${finding.type}|${location.file}|${location.cssRule?.startLine ?? location.line}`;
        const group = groups.get(key);
        if (group) group.findings.push(finding);
        else groups.set(key, { location, findings: [finding] });
      }
      for (const { location, findings: related } of groups.values()) {
        budget.assertActive();
        let proposal: PatchProposal;
        try { proposal = await generator.generatePatch(related[0], location); }
        catch (err) {
          if (isBudgetError(err)) throw err;
          console.warn(`No patch proposed for ${related[0].id}: ${(err as Error).message}`);
          continue;
        }
        proposal.findingIds = related.map((f) => f.id);
        const proposalIndex = proposals.push(proposal) - 1;
        for (const finding of related) finding.proposedFixId = proposal.id;
        if (this.config.verifyInWorktree !== false) {
          const checks = [];
          try {
            for (const finding of related) {
              checks.push(await verifier.verifyPatch(proposal, this.config.scanConfig
                ? { finding, scanConfig: this.config.scanConfig, outputDir, budget } : undefined));
              if (budget.snapshot().stopped) break;
            }
          } catch (error) {
            if (isBudgetError(error) || budget.signal.aborted) {
              proposal.verificationStatus = "unverified";
              proposal.verificationMessage = `Verification stopped: ${budget.snapshot().stopped?.message ?? (error as Error).message}`;
            }
            throw error;
          }
          const worst = checks.find((c) => c.verificationStatus === "failed") ?? checks.find((c) => c.verificationStatus !== "verified") ?? checks[0];
          proposal = { ...worst, findingIds: proposal.findingIds, verifications: checks.map((c, i) => ({
            findingId: related[i].id, targetId: related[i].targetId, status: c.verificationStatus, message: c.verificationMessage,
            beforeScreenshotPath: c.beforeScreenshotPath, afterScreenshotPath: c.verifiedScreenshotPath
          })) };
        }
        proposals[proposalIndex] = proposal;
      }
      await save();
      return proposals;
    } catch (error) {
      if (!isBudgetError(error) && !budget.signal.aborted) throw error;
      await save();
      return proposals;
    } finally {
      detachAbort?.();
      await cdp?.close();
      await server?.cleanup();
      if (!this.config.budget) budget.dispose();
    }
  }
}

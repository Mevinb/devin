import fs from "node:fs/promises";
import path from "node:path";
import type { Finding } from "@pixelsentinel/core";
import { PatchGenerator } from "./generator.js";
import { SourceMapResolver } from "./sourcemap.js";
import type { FixerConfig, PatchProposal } from "./types.js";
import { PatchVerifier } from "./verifier.js";
import { WorktreeManager } from "./worktree.js";

export * from "./types.js";
export * from "./sourcemap.js";
export * from "./generator.js";
export * from "./worktree.js";
export * from "./verifier.js";

export class FixProposalEngine {
  private resolver: SourceMapResolver;
  private generator: PatchGenerator;
  private verifier: PatchVerifier;

  constructor(private readonly config: FixerConfig) {
    this.resolver = new SourceMapResolver(config.repoRoot);
    this.generator = new PatchGenerator();
    this.verifier = new PatchVerifier(config.repoRoot);
  }

  async proposeFixes(
    findings: Finding[],
    outputDir?: string
  ): Promise<PatchProposal[]> {
    const proposals: PatchProposal[] = [];

    for (const finding of findings) {
      const location = await this.resolver.resolveLocation(finding);
      if (!location) continue;

      let proposal = await this.generator.generatePatch(finding, location);

      if (this.config.verifyInWorktree !== false) {
        proposal = await this.verifier.verifyPatch(proposal);
      }

      finding.proposedFixId = proposal.id;
      proposals.push(proposal);
    }

    if (outputDir && proposals.length > 0) {
      const fixesDir = path.join(outputDir, "fixes");
      await fs.mkdir(fixesDir, { recursive: true });
      await fs.writeFile(
        path.join(fixesDir, "proposals.json"),
        JSON.stringify(proposals, null, 2),
        "utf8"
      );
    }

    return proposals;
  }
}

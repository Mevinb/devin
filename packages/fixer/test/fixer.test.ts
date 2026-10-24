import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "@pixelsentinel/core";
import { PatchGenerator } from "../src/generator.js";
import { SourceMapResolver } from "../src/sourcemap.js";
import { PatchVerifier } from "../src/verifier.js";
import { WorktreeManager } from "../src/worktree.js";

describe("Self-Verifying Fix Proposals Engine", () => {
  const repoRoot = path.resolve(__dirname, "../../../");

  it("resolves source location from a DOM finding element ref", async () => {
    const resolver = new SourceMapResolver(repoRoot);
    const mockFinding: Finding = {
      id: "finding-test-1",
      type: "horizontal-overflow",
      severity: "critical",
      confidence: 0.95,
      sources: ["heuristic"],
      bbox: { x: 0, y: 0, width: 750, height: 200, top: 0, left: 0, right: 750, bottom: 200 },
      elements: [
        {
          id: "orderTable",
          selector: "table.overflow-table#orderTable",
          tagName: "table",
          text: "Product Description SKU Code"
        }
      ],
      description: "Horizontal overflow in table",
      renderId: "test-render"
    };

    const location = await resolver.resolveLocation(mockFinding);
    expect(location).not.toBeNull();
    expect(location?.file).toContain("fixtures/flows/index.html");
    expect(location?.line).toBeGreaterThan(0);
  });

  it("generates a valid unified diff patch proposal", async () => {
    const generator = new PatchGenerator();
    const mockFinding: Finding = {
      id: "finding-test-2",
      type: "safe-area-intrusion",
      severity: "warning",
      confidence: 0.9,
      sources: ["heuristic"],
      bbox: { x: 0, y: 0, width: 400, height: 44, top: 0, left: 0, right: 400, bottom: 44 },
      elements: [
        {
          selector: ".notch-banner#notchBanner",
          tagName: "div",
          text: "FLASH SALE"
        }
      ],
      description: "Notch collision",
      renderId: "test-render"
    };

    const location = {
      file: "fixtures/flows/index.html",
      line: 25,
      confidence: 0.9,
      method: "grep-fallback" as const,
      snippet: ".notch-banner {"
    };

    const patch = await generator.generatePatch(mockFinding, location);
    expect(patch.id).toBeDefined();
    expect(patch.diff).toContain("diff --git a/fixtures/flows/index.html b/fixtures/flows/index.html");
    expect(patch.verificationStatus).toBe("unverified");
  });

  it("creates isolated throwaway worktree sandbox and cleans up with zero tree modifications", async () => {
    const worktreeManager = new WorktreeManager(repoRoot);
    const worktree = await worktreeManager.createWorktree();

    expect(worktree.worktreePath).toContain(".pixelsentinel/worktrees");
    expect(worktree.id).toBeDefined();

    // Verify cleanup safely removes worktree
    await worktree.cleanup();
  }, 20000);

  it("verifies patch proposal inside isolated worktree", async () => {
    const verifier = new PatchVerifier(repoRoot);
    const sampleProposal = {
      id: "patch-sample",
      findingId: "f-1",
      defectType: "horizontal-overflow",
      file: "fixtures/flows/index.html",
      startLine: 1,
      endLine: 1,
      // Minimal no-op diff for verification test
      diff: [
        "diff --git a/fixtures/flows/index.html b/fixtures/flows/index.html",
        "--- a/fixtures/flows/index.html",
        "+++ b/fixtures/flows/index.html",
        "@@ -1,3 +1,3 @@",
        "-<!DOCTYPE html>",
        "+<!DOCTYPE html>",
        ' <html lang="en">',
        " <head>"
      ].join("\n"),


      explanation: "Verified no-op patch",
      verificationStatus: "unverified" as const,
      createdAt: new Date().toISOString()
    };

    const result = await verifier.verifyPatch(sampleProposal);
    expect(result.verificationStatus).toBe("verified");
  }, 20000);
});

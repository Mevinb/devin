import crypto from "node:crypto";
import OpenAI from "openai";
import type { Finding } from "@pixelsentinel/core";
import type { PatchProposal, SourceLocation } from "./types.js";

export class PatchGenerator {
  private openai: OpenAI | null = null;

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async generatePatch(
    finding: Finding,
    location: SourceLocation
  ): Promise<PatchProposal> {
    const patchId = `patch-${crypto.randomUUID().slice(0, 8)}`;
    const contextLines = location.contextLines?.lines.join("\n") || location.snippet || "";

    if (this.openai) {
      const prompt = `You are an expert frontend and CSS engineer specializing in responsive layout bug fixes.
We detected the following visual defect in PixelSentinel QA:
Defect Type: ${finding.type}
Severity: ${finding.severity}
Description: ${finding.description}
Suggested Solution: ${finding.suggestedFix || "Fix layout clipping/overflow/overlap/safe-area issue"}

Source file: ${location.file}
Approximate Line: ${location.line}
Surrounding Code:
\`\`\`
${contextLines}
\`\`\`

REQUIREMENTS:
1. Provide a minimal, surgical fix that resolves the issue without unnecessary reformatting.
2. Output a strictly valid unified diff in standard git format starting with \`diff --git a/${location.file} b/${location.file}\`.
3. Provide a 1-sentence explanation of what was changed and why.

Output JSON format:
{
  "explanation": "...",
  "diff": "..."
}`;

      try {
        const response = await this.openai.chat.completions.create({
          model: "gpt-4o",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }]
        });

        const content = response.choices[0]?.message.content;
        if (content) {
          const parsed = JSON.parse(content);
          if (parsed.diff && parsed.diff.includes("diff --git")) {
            return {
              id: patchId,
              findingId: finding.id,
              defectType: finding.type,
              file: location.file,
              startLine: location.line,
              endLine: location.line,
              diff: parsed.diff.trim(),
              explanation: parsed.explanation || "Automated layout fix",
              verificationStatus: "unverified",
              reproductionTrace: finding.trace,
              targetId: finding.targetId,
              createdAt: new Date().toISOString()
            };
          }
        }
      } catch {
        // Fall back to template diff
      }
    }

    // Fallback deterministic patch generator
    const snippetLine = location.snippet || "/* style */";
    let replacement = snippetLine;
    let explanation = `Applied fix for ${finding.type}`;

    if (finding.type === "horizontal-overflow") {
      replacement = `${snippetLine}\n  max-width: 100%;\n  overflow-x: hidden;`;
      explanation = "Added max-width: 100% and overflow-x: hidden to prevent horizontal scrolling";
    } else if (finding.type === "safe-area-intrusion") {
      replacement = `${snippetLine}\n  padding-top: max(16px, env(safe-area-inset-top));`;
      explanation = "Added safe-area-inset-top padding to avoid hardware cutout overlap";
    } else if (finding.type === "hinge-overlap") {
      replacement = `${snippetLine}\n  width: calc(50% - 10px); /* Foldable split */`;
      explanation = "Adjusted width to keep content on single screen segment";
    } else if (finding.type === "tv-missing-focus-ring") {
      replacement = `${snippetLine}\n  outline: 3px solid #3b82f6;\n  outline-offset: 4px;`;
      explanation = "Added high-contrast outline for TV D-pad focus visibility";
    }

    const diff = [
      `diff --git a/${location.file} b/${location.file}`,
      `--- a/${location.file}`,
      `+++ b/${location.file}`,
      `@@ -${location.line},1 +${location.line},3 @@`,
      `-${snippetLine}`,
      `+${replacement}`
    ].join("\n");

    return {
      id: patchId,
      findingId: finding.id,
      defectType: finding.type,
      file: location.file,
      startLine: location.line,
      endLine: location.line,
      diff,
      explanation,
      verificationStatus: "unverified",
      reproductionTrace: finding.trace,
      targetId: finding.targetId,
      createdAt: new Date().toISOString()
    };
  }
}

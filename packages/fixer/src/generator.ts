import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCssRules, parseEmbeddedStyles, STYLE_EXTS } from "./css.js";
import OpenAI from "openai";
import { isBudgetError, RunBudget, type AgentAction, type Finding } from "@pixelsentinel/core";
import type { PatchProposal, SourceLocation } from "./types.js";

export class PatchGenerator {
  private openai: OpenAI | null = null;

  constructor(apiKey = process.env.OPENAI_API_KEY, private readonly model = "gpt-4o", private readonly repoRoot = process.cwd(), private readonly budget = new RunBudget()) {
    if (apiKey) {
      this.openai = new OpenAI({ apiKey, maxRetries: 0, timeout: 30000 });
    }
  }

  async generatePatch(
    finding: Finding,
    location: SourceLocation
  ): Promise<PatchProposal> {
    this.budget.assertActive();
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
        const response = await this.budget.request("fixer", this.model, 4096, (requestOptions) => this.openai!.chat.completions.create({
          model: this.model,
          max_tokens: 4096,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }]
        }, requestOptions));

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
              diff: parsed.diff.trim() + "\n",
              explanation: parsed.explanation || "Automated layout fix",
              verificationStatus: "unverified",
              reproductionTrace: finding.trace,
              actions: finding.actions as AgentAction[] | undefined,
              targetId: finding.targetId,
              createdAt: new Date().toISOString()
            };
          }
        }
      } catch (error) {
        if (isBudgetError(error)) throw error;
        // Fall back to template diff
      }
    }

    // Offline templates only edit a structurally located CSS rule. Never insert CSS in markup.
    const filePath = path.resolve(this.repoRoot, location.file);
    if (!filePath.startsWith(path.resolve(this.repoRoot) + path.sep)) throw new Error("Source file escapes repository");
    const original = await fs.readFile(filePath, "utf8");
    const rules = STYLE_EXTS.includes(path.extname(filePath))
      ? parseCssRules(original, location.file) : parseEmbeddedStyles(original, location.file);
    const rule = location.cssRule ?? rules.find((r) => r.startLine <= location.line && r.closeLine >= location.line);
    if (!rule) throw new Error(`No CSS rule found for ${location.file}:${location.line}; an AI patch is required`);

    const declarations: Partial<Record<Finding["type"], string>> = {
      // A table needs its intrinsic column widths. Squeezing it into equal columns
      // can pass overflow checks while turning ordinary words into vertical text.
      "horizontal-overflow": finding.elements[0]?.tagName === "table"
        ? "display: block; width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow-x: auto; overflow-wrap: normal; table-layout: auto;"
        : "width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow-wrap: anywhere;",
      "safe-area-intrusion": "padding-top: max(16px, env(safe-area-inset-top));",
      "tv-missing-focus-ring": "outline: 3px solid #3b82f6; outline-offset: 4px;",
      "tiny-tap-target": "min-width: 24px; min-height: 24px;",
      "text-clipping": "overflow: visible; white-space: normal; overflow-wrap: anywhere; height: auto;"
    };
    const declaration = declarations[finding.type];
    const body = original.slice(rule.openOffset + 1, rule.closeOffset).trimEnd();
    const repair = finding.type === "element-overlap" && /\bmargin-top\s*:\s*-\d/.test(body) ? "margin-top: 16px;" : declaration;
    if (!repair) throw new Error(`No deterministic patch for ${finding.type}; an AI patch is required`);
    // End the preceding declaration even when authored CSS omitted its final semicolon.
    const separator = body && !/[;}]$/.test(body) ? ";" : "";
    const replacement = original.slice(0, rule.openOffset + 1) + body + separator +
      `\n  ${repair}\n` + original.slice(rule.closeOffset);
    const diff = unifiedDiff(location.file, original, replacement);
    const explanation = `Updated ${rule.selectorText} to address ${finding.type}; requires rendering verification.`;

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
      actions: finding.actions as AgentAction[] | undefined,
      targetId: finding.targetId,
      createdAt: new Date().toISOString()
    };
  }
}

/** A valid single hunk with exact counts and context, including the final-newline marker. */
export function unifiedDiff(file: string, before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  if (before.endsWith("\n")) oldLines.pop();
  if (after.endsWith("\n")) newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3);
  const endOld = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const endNew = Math.min(newLines.length, newLines.length - suffix + 3);
  const lines = [
    `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`,
    `@@ -${start + 1},${endOld - start} +${start + 1},${endNew - start} @@`
  ];
  const addLine = (prefix: string, text: string, noNewline: boolean) => {
    lines.push(prefix + text);
    if (noNewline) lines.push("\\ No newline at end of file");
  };
  for (let i = start; i < prefix; i++) addLine(" ", oldLines[i], false);
  for (let i = prefix; i < oldLines.length - suffix; i++) addLine("-", oldLines[i], i === oldLines.length - 1 && !before.endsWith("\n"));
  for (let i = prefix; i < newLines.length - suffix; i++) addLine("+", newLines[i], i === newLines.length - 1 && !after.endsWith("\n"));
  for (let i = oldLines.length - suffix; i < endOld; i++) addLine(" ", oldLines[i], i === oldLines.length - 1 && !before.endsWith("\n"));
  return lines.join("\n") + "\n";
}

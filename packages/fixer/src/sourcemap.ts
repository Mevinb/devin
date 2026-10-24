import fs from "node:fs/promises";
import path from "node:path";
import type { Finding } from "@pixelsentinel/core";
import type { SourceLocation } from "./types.js";

export class SourceMapResolver {
  constructor(private readonly repoRoot: string) {}

  async resolveLocation(finding: Finding): Promise<SourceLocation | null> {
    if (!finding.elements || finding.elements.length === 0) {
      return null;
    }

    const primaryEl = finding.elements[0];

    // 1. Try class name / ID lookup across source directories
    const tokens: string[] = [];
    if (primaryEl.id) {
      tokens.push(primaryEl.id);
    }

    const classMatches = primaryEl.selector.match(/\.([a-zA-Z0-9_-]+)/g);
    if (classMatches) {
      for (const cls of classMatches) {
        const clean = cls.replace(".", "");
        if (clean.length > 2 && !clean.startsWith("css-")) {
          tokens.push(clean);
        }
      }
    }

    // 2. Try text search if unique enough
    if (primaryEl.text && primaryEl.text.trim().length > 4 && primaryEl.text.trim().length < 40) {
      tokens.push(primaryEl.text.trim());
    }

    // Search common source directories
    const searchDirs = ["src", "app", "components", "pages", "styles", "fixtures", "."];
    for (const searchDir of searchDirs) {
      const fullDir = path.join(this.repoRoot, searchDir);
      try {
        const stat = await fs.stat(fullDir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      for (const token of tokens) {
        const found = await this.searchDirectoryForToken(fullDir, token);
        if (found) {
          const context = await this.extractContextLines(found.file, found.line);
          return {
            file: path.relative(this.repoRoot, found.file),
            line: found.line,
            confidence: 0.85,
            method: "grep-fallback",
            snippet: found.lineContent,
            contextLines: context
          };
        }
      }
    }

    return null;
  }

  private async searchDirectoryForToken(
    dir: string,
    token: string,
    depth = 0
  ): Promise<{ file: string; line: number; lineContent: string } | null> {
    if (depth > 6) return null;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name === "build" ||
          entry.name === ".pixelsentinel" ||
          entry.name.startsWith("pixelsentinel-output")
        ) {
          continue;
        }

        const sub = await this.searchDirectoryForToken(fullPath, token, depth + 1);
        if (sub) return sub;
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        const validExts = [".tsx", ".jsx", ".ts", ".js", ".css", ".scss", ".html", ".vue", ".svelte"];
        if (!validExts.includes(ext)) continue;

        try {
          const content = await fs.readFile(fullPath, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(token)) {
              return { file: fullPath, line: i + 1, lineContent: lines[i].trim() };
            }
          }
        } catch {
          // ignore read error
        }
      }
    }

    return null;
  }

  private async extractContextLines(
    filePath: string,
    targetLine: number,
    windowSize = 25
  ): Promise<{ startLine: number; lines: string[] }> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const allLines = content.split("\n");
      const startLine = Math.max(1, targetLine - windowSize);
      const endLine = Math.min(allLines.length, targetLine + windowSize);
      const lines = allLines.slice(startLine - 1, endLine);
      return { startLine, lines };
    } catch {
      return { startLine: targetLine, lines: [] };
    }
  }
}

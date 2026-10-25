import fs from "node:fs/promises";
import path from "node:path";
import type { Finding, RunBudget } from "@pixelsentinel/core";
import type { SourceLocation } from "./types.js";
import { MARKUP_EXTS, STYLE_EXTS, parseCssRules, parseEmbeddedStyles, scoreRule, tokensFromSelector } from "./css.js";
import type { CdpCssResolver } from "./cdp-css.js";

export class SourceMapResolver {
  constructor(private readonly repoRoot: string, private readonly cdp?: CdpCssResolver, private readonly budget?: RunBudget) {}

  async resolveLocation(finding: Finding): Promise<SourceLocation | null> {
    this.budget?.assertActive();
    if (!finding.elements || finding.elements.length === 0) {
      return null;
    }

    const primaryEl = finding.elements[0];
    const elements = finding.type === "element-overlap" ? finding.elements : [primaryEl];
    const causalScore = (text: string) => finding.type === "element-overlap" && /\b(?:margin(?:-top|-left|-right|-bottom)?|top|left|right|bottom)\s*:\s*-\d/.test(text) ? 20 : 0;

    // Use the live CSS cascade / source map when a dev server is available.
    if (this.cdp) {
      let best: { location: SourceLocation; score: number } | undefined;
      for (const element of elements) {
        const locations = await this.cdp.resolve(element.selector, { deviceId: finding.targetId, renderId: finding.renderId, renderConfig: finding.renderConfig, actions: finding.actions });
        this.budget?.assertActive();
        for (const loc of locations) {
          const fullPath = path.resolve(this.repoRoot, loc.file);
          if (!fullPath.startsWith(path.resolve(this.repoRoot) + path.sep)) continue;
          try {
            const content = await fs.readFile(fullPath, "utf8");
            const rules = STYLE_EXTS.includes(path.extname(fullPath))
              ? parseCssRules(content, loc.file) : parseEmbeddedStyles(content, loc.file);
            const candidates = rules.filter((r) => r.startLine <= loc.line && r.closeLine >= loc.line);
            const normalize = (selector: string) => selector.split(",").map((part) => part.trim().replace(/\s+/g, " ")).join(",");
            const exact = candidates.filter((r) => normalize(r.selectorText) === normalize(loc.selectorText));
            const offset = loc.column === undefined ? undefined : content.split("\n").slice(0, loc.line - 1).reduce((total, line) => total + line.length + 1, 0) + loc.column;
            const positioned = offset === undefined ? [] : candidates.filter((r) => r.startOffset <= offset && r.closeOffset >= offset)
              .sort((a, b) => (a.closeOffset - a.startOffset) - (b.closeOffset - b.startOffset));
            const rule = positioned[0] ?? (exact.length === 1 ? exact[0] : undefined) ?? (candidates.length === 1 ? candidates[0] : undefined);
            // Minified/inline styles can put several rules on one line. Never
            // patch its first rule merely because the source line is correct.
            if (!rule && candidates.length > 1) continue;
            const location: SourceLocation = {
              ...loc, confidence: 0.98, cssRule: rule,
              snippet: content.split("\n")[loc.line - 1],
              contextLines: await this.extractContextLines(fullPath, loc.line)
            };
            const score = rule ? causalScore(content.slice(rule.openOffset + 1, rule.closeOffset)) : 0;
            if (!best || score > best.score) best = { location, score };
            if (finding.type !== "element-overlap") return location;
          } catch { /* Try another mapped source. */ }
        }
      }
      if (best) return best.location;
    }

    // Locate an actual style rule, never an HTML attribute that happens to mention a class.
    let best: { file: string; rule: import("./css.js").CssRule; score: number } | undefined;
    for (const file of await this.sourceFiles(this.repoRoot)) {
      this.budget?.assertActive();
      const content = await fs.readFile(file, "utf8");
      const rel = path.relative(this.repoRoot, file);
      const rules = STYLE_EXTS.includes(path.extname(file))
        ? parseCssRules(content, rel) : parseEmbeddedStyles(content, rel);
      for (const rule of rules) {
        const match = Math.max(...elements.map((element) => scoreRule(rule, tokensFromSelector(element.selector, element.tagName))));
        const score = match > 0 ? match + causalScore(content.slice(rule.openOffset + 1, rule.closeOffset)) : 0;
        if (score > (best?.score ?? 0)) best = { file, rule, score };
      }
    }
    if (best) {
      const content = await fs.readFile(best.file, "utf8");
      return {
        file: path.relative(this.repoRoot, best.file), line: best.rule.startLine,
        confidence: 0.85, method: "grep-fallback", cssRule: best.rule,
        snippet: content.split("\n")[best.rule.startLine - 1],
        contextLines: await this.extractContextLines(best.file, best.rule.startLine)
      };
    }

    const source = primaryEl.source;
    if (source) {
      const file = path.resolve(this.repoRoot, source.file);
      if (file.startsWith(path.resolve(this.repoRoot) + path.sep)) {
        try {
          const contextLines = await this.extractContextLines(file, source.line);
          if (contextLines.lines.length) return {
            file: path.relative(this.repoRoot, file), line: source.line,
            confidence: 0.95, method: "react-debug", contextLines,
            snippet: contextLines.lines[source.line - contextLines.startLine]
          };
        } catch { /* Fall back to token search. */ }
      }
    }

    const tokens: string[] = [];
    const selectorIds = primaryEl.selector.matchAll(/#([a-zA-Z_][\w-]*)/g);
    for (const match of selectorIds) tokens.push(match[1]);
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

  private async sourceFiles(dir: string, depth = 0): Promise<string[]> {
    if (depth > 8) return [];
    const files: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      this.budget?.assertActive();
      if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "coverage", "scratch"].includes(entry.name) || entry.name.startsWith("pixelsentinel-output")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await this.sourceFiles(file, depth + 1));
      else if (entry.isFile() && [...STYLE_EXTS, ...MARKUP_EXTS].includes(path.extname(file))) files.push(file);
    }
    return files;
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

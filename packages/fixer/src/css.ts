/** Minimal CSS rule locator: enough structure to find a rule's selector and its { } line range. */
export interface CssRule {
  /** Repo-relative file path. */
  file: string;
  selectorText: string;
  /** 1-based line of the selector start, `{` and the closing `}`. */
  startLine: number;
  openLine: number;
  closeLine: number;
  startOffset: number;
  openOffset: number;
  closeOffset: number;
}

export const STYLE_EXTS = [".css", ".scss", ".sass", ".less"];
export const MARKUP_EXTS = [".html", ".htm", ".vue", ".svelte", ".astro"];

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Parse rules from CSS text. `lineOffset` shifts lines for <style> blocks embedded in markup. */
export function parseCssRules(text: string, file: string, lineOffset = 0): CssRule[] {
  const rules: CssRule[] = [];
  const stack: Array<{ rule?: Omit<CssRule, "closeLine" | "closeOffset">; }> = [];
  let preludeStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      if (text.slice(preludeStart, i + 1).trim().startsWith("/*")) preludeStart = i + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === ch) break;
      }
      continue;
    }
    if (ch === "{") {
      const prelude = text.slice(preludeStart, i);
      const trimmed = prelude.trim();
      const startIdx = preludeStart + prelude.indexOf(trimmed);
      if (trimmed && !trimmed.startsWith("@")) {
        stack.push({
          rule: {
            file,
            selectorText: trimmed.replace(/\s+/g, " "),
            startLine: lineAt(text, startIdx) + lineOffset,
            startOffset: startIdx,
            openLine: lineAt(text, i) + lineOffset,
            openOffset: i
          }
        });
      } else {
        stack.push({});
      }
      preludeStart = i + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      if (top?.rule) rules.push({ ...top.rule, closeLine: lineAt(text, i) + lineOffset, closeOffset: i });
      preludeStart = i + 1;
    } else if (ch === ";") {
      preludeStart = i + 1;
    }
  }
  return rules;
}

/** Extract rules from <style> blocks inside HTML / Vue / Svelte files. */
export function parseEmbeddedStyles(text: string, file: string): CssRule[] {
  const rules: CssRule[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const contentStart = m.index + m[0].indexOf(">") + 1;
    rules.push(...parseCssRules(m[1], file, lineAt(text, contentStart) - 1).map((rule) => ({
      ...rule, startOffset: rule.startOffset + contentStart, openOffset: rule.openOffset + contentStart, closeOffset: rule.closeOffset + contentStart
    })));
  }
  return rules;
}

export interface ElementTokens {
  id?: string;
  classes: string[];
  tag?: string;
  ancestorIds: string[];
  ancestorClasses: string[];
}

/** Split a PixelSentinel selector (`div#card > p.title:nth-of-type(2)`) into element + ancestor tokens. */
export function tokensFromSelector(selector: string, tagName?: string): ElementTokens {
  const parts = selector.split(/\s*>\s*|\s+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const ancestors = parts.slice(0, -1).join(" ");
  const ids = (s: string) => [...s.matchAll(/#([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  const classes = (s: string) => [...s.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]);
  return {
    id: ids(last)[0],
    classes: classes(last),
    tag: tagName ?? last.match(/^[a-z][a-z0-9]*/)?.[0],
    ancestorIds: ids(ancestors),
    ancestorClasses: classes(ancestors)
  };
}

function compoundHas(compound: string, kind: "#" | ".", name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\${kind}${esc}(?![\\w-])`).test(compound);
}

/** Score how directly a rule styles the element (higher = more direct). 0 = unrelated. */
export function scoreRule(rule: CssRule, t: ElementTokens): number {
  let best = 0;
  for (const sel of rule.selectorText.split(",")) {
    const s = sel.trim().replace(/::?[a-z-]+(\([^)]*\))?/g, "");
    const compounds = s.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    const last = compounds[compounds.length - 1] ?? "";
    const before = compounds.slice(0, -1).join(" ");
    let score = 0;
    if (t.id && compoundHas(last, "#", t.id)) score = 10;
    else if (t.classes.some((c) => compoundHas(last, ".", c))) score = 8;
    else if (t.tag && new RegExp(`^${t.tag}(?![\\w-])`).test(last) && (t.ancestorIds.some((id) => compoundHas(before, "#", id)) || t.ancestorClasses.some((c) => compoundHas(before, ".", c)))) score = 6;
    else if (t.ancestorIds.some((id) => compoundHas(last, "#", id)) || t.ancestorClasses.some((c) => compoundHas(last, ".", c))) score = 2;
    best = Math.max(best, score);
  }
  return best;
}

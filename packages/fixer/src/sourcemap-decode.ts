import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export interface RawSourceMap {
  sources: string[];
  sourceRoot?: string;
  mappings: string;
  resolvedUrl?: string;
}

/** Mapped segments are [genCol, srcIdx, srcLine, srcCol]; [genCol] marks an unmapped span. */
export function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const lineStr of mappings.split(";")) {
    const segments: number[][] = [];
    let genCol = 0;
    for (const seg of lineStr.split(",")) {
      if (!seg) continue;
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of seg) {
        const digit = B64_INDEX.get(ch);
        if (digit === undefined) break;
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >> 1) : value >> 1);
          value = 0;
          shift = 0;
        }
      }
      genCol += values[0] ?? 0;
      if (values.length === 1) segments.push([genCol]);
      else if (values.length >= 4) {
        srcIdx += values[1];
        srcLine += values[2];
        srcCol += values[3];
        segments.push([genCol, srcIdx, srcLine, srcCol]);
      }
    }
    lines.push(segments);
  }
  return lines;
}

/** Original position for a 1-based generated line and 0-based column. */
export function originalPositionFor(
  map: RawSourceMap,
  line: number,
  column: number
): { source: string; line: number; column: number } | null {
  const decoded = decodeMappings(map.mappings);
  const candidates = (decoded[line - 1] ?? []).filter((segment) => segment[0] <= column);
  const seg = candidates.at(-1);
  if (!seg || seg.length < 4 || !map.sources[seg[1]]) return null;
  let source = (map.sourceRoot ? map.sourceRoot.replace(/\/?$/, "/") : "") + map.sources[seg[1]];
  if (map.resolvedUrl) source = new URL(source, map.resolvedUrl).href;
  return { source, line: seg[2] + 1, column: seg[3] };
}

export async function loadSourceMap(mapUrl: string, baseUrl: string, signal?: AbortSignal): Promise<RawSourceMap | null> {
  try {
    if (mapUrl.startsWith("data:")) {
      const [, meta, data] = mapUrl.match(/^data:([^,]*),(.*)$/s) ?? [];
      const json = meta?.includes("base64") ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
      return { ...JSON.parse(json), resolvedUrl: baseUrl };
    }
    const resolvedUrl = new URL(mapUrl, baseUrl).href;
    const res = await fetch(resolvedUrl, { signal });
    return res.ok ? { ...((await res.json()) as RawSourceMap), resolvedUrl } : null;
  } catch {
    return null;
  }
}

/**
 * Map a served URL / sourcemap source back to a repo-relative file:
 * static-served files, Vite (`/src/x.css`, `/@fs/abs`), webpack (`webpack:///./src/x`), absolute paths.
 */
export function urlToRepoFile(urlOrPath: string, repoRoot: string, projectDirs: string[]): string | null {
  const root = realpathSync(repoRoot);
  let p = urlOrPath;
  try {
    if (/^https?:\/\//.test(p)) p = decodeURIComponent(new URL(p).pathname);
    else if (p.startsWith("file://")) p = fileURLToPath(p);
  } catch {
    // keep as-is
  }
  p = p
    .replace(/^webpack:\/\/\/?(\[name\]\/|[^/]*\/)?/, "")
    .replace(/^file:\/\//, "")
    .replace(/\?.*$/, "")
    .replace(/^\/@fs/, "");
  const candidates: string[] = [];
  if (path.isAbsolute(p)) candidates.push(p);
  for (const dir of projectDirs) candidates.push(path.join(dir, p.replace(/^\.?\//, "")));
  candidates.push(path.join(repoRoot, p.replace(/^\.?\//, "")));
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && realpathSync(c).startsWith(root + path.sep)) return path.relative(repoRoot, c);
  }
  return null;
}

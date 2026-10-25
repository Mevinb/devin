import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/generator.js";
import { parseEmbeddedStyles, tokensFromSelector, scoreRule } from "../src/css.js";
import { originalPositionFor, urlToRepoFile } from "../src/sourcemap-decode.js";
import { scan, startStaticServer } from "@pixelsentinel/core";
import { CdpCssResolver } from "../src/cdp-css.js";
import { SourceMapResolver } from "../src/sourcemap.js";

const exec = promisify(execFile);
describe("Patch and source location accuracy", () => {
  it("produces applicable hunks for one-line CSS, missing final newlines, and multiple changed lines", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ps-hunks-"));
    try {
      await exec("git", ["init", "-q", dir]);
      for (const [before, after] of [
        [".card { width: 720px; }", ".card { width: 100%; }"],
        ["a\nb\nc", "a\nB\nc"],
        ["a\nb\nc\n", "a\nB\nC\nextra\n"],
        ["a\nb\nc", "a\nB\nC"]
      ]) {
        await fs.writeFile(path.join(dir, "style.css"), before);
        await fs.writeFile(path.join(dir, "fix.diff"), unifiedDiff("style.css", before, after));
        await exec("git", ["apply", "--check", "fix.diff"], { cwd: dir });
        await exec("git", ["apply", "fix.diff"], { cwd: dir });
        expect(await fs.readFile(path.join(dir, "style.css"), "utf8")).toBe(after);
      }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("locates embedded rules without confusing strings, nested media queries or HTML tags", () => {
    const html = '<html>\n<style>\n@media (max-width: 500px) {\n#card { content: "\\\"}quoted"; width: 720px; }\n}\n</style>\n<div id="card">Card</div></html>';
    const rules = parseEmbeddedStyles(html, "index.html");
    expect(rules).toHaveLength(1);
    expect(rules[0].selectorText).toBe("#card");
    expect(rules[0].startLine).toBe(4);
    expect(html[rules[0].openOffset]).toBe("{");
    expect(html.slice(rules[0].openOffset, rules[0].closeOffset + 1)).toContain("width: 720px");
    expect(scoreRule(rules[0], tokensFromSelector("div#card"))).toBeGreaterThan(0);
  });

  it("never borrows a sourcemap location from an unmapped line or a later generated column", () => {
    expect(originalPositionFor({ sources: ["src/style.scss"], mappings: "AAAA;;" }, 3, 0)).toBeNull();
    expect(originalPositionFor({ sources: ["src/style.scss"], mappings: "KAAA" }, 1, 0)).toBeNull();
    const gaps = { sources: ["src/style.scss"], mappings: "AAAA,K,KACA" };
    expect(originalPositionFor(gaps, 1, 4)).toEqual({ source: "src/style.scss", line: 1, column: 0 });
    expect(originalPositionFor(gaps, 1, 5)).toBeNull();
    expect(originalPositionFor(gaps, 1, 8)).toBeNull();
    expect(originalPositionFor(gaps, 1, 10)).toEqual({ source: "src/style.scss", line: 2, column: 0 });
    expect(originalPositionFor({ sources: ["src/style.scss"], mappings: "AAAA", sourceRoot: "../", resolvedUrl: "https://example.test/maps/app.css.map" }, 1, 4))
      .toEqual({ source: "https://example.test/src/style.scss", line: 1, column: 0 });
  });

  it("maps static and Vite URLs but rejects similarly named sibling directories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ps-map-"));
    const sibling = dir + "-outside";
    try {
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(dir, "style.css"), "a {}");
      await fs.writeFile(path.join(sibling, "style.css"), "a {}");
      expect(urlToRepoFile("http://localhost:1234/style.css?cache=1", dir, [dir])).toBe("style.css");
      expect(urlToRepoFile(`http://localhost:1234/@fs${dir}/style.css`, dir, [dir])).toBe("style.css");
      expect(urlToRepoFile(path.join(sibling, "style.css"), dir, [])).toBeNull();
    } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(sibling, { recursive: true, force: true }); }
  });

  it.each(["viewport", "custom-device", "same-line-rules"])("uses the captured responsive CSS for a %s instead of desktop fallback", async (kind) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ps-responsive-map-"));
    const project = path.join(dir, "project"); await fs.mkdir(project);
    const source = kind === "same-line-rules"
      ? '<meta name="viewport" content="width=device-width"><style>body{margin:0}#wide{width:100%}@media(max-width:500px){#wide{width:750px}}</style><div id="wide">Responsive overflow</div>'
      : '<meta name="viewport" content="width=device-width"><style>\n#wide { width: 100%; }\n@media (max-width: 500px) {\n#wide { width: 750px; }\n}\n</style><div id="wide">Responsive overflow</div>';
    await fs.writeFile(path.join(project, "index.html"), source);
    const viewport = { name: "Custom phone", width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, orientation: "portrait" as const };
    const config = { target: project, ...(kind === "viewport" ? { viewports: [viewport] } : { devices: [{ id: "custom:phone", name: viewport.name,
      runtime: "playwright" as const, fidelity: "approximate" as const, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }] }),
      vision: { enabled: false }, extraWaitMs: 0, output: { dir: path.join(dir, "out") } };
    let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
    let cdp: CdpCssResolver | undefined;
    try {
      const report = await scan(config);
      const finding = report.matrix[0].findings.find((item) => item.type === "horizontal-overflow")!;
      expect(finding).toBeDefined(); expect(finding.renderConfig?.width).toBe(390);
      server = await startStaticServer(project); cdp = new CdpCssResolver(server.url, project, [project], config);
      const resolver = new SourceMapResolver(project, cdp);
      const location = await resolver.resolveLocation(finding);
      expect(location).toMatchObject({ file: "index.html", line: kind === "same-line-rules" ? 1 : 4, method: "css-cdp" });
      expect(source.slice(location!.cssRule!.openOffset, location!.cssRule!.closeOffset)).toMatch(/width:\s*750px/);
      // Older saved reports can recover geometry from the original scan config.
      expect(await resolver.resolveLocation({ ...finding, renderConfig: undefined })).toMatchObject({ line: kind === "same-line-rules" ? 1 : 4, method: "css-cdp" });
      expect(await cdp.resolve("#wide", { deviceId: "unknown:device" })).toEqual([]);
    } finally { await cdp?.close(); await server?.cleanup(); await fs.rm(dir, { recursive: true, force: true }); }
  }, 15000);
});

import { chromium, type Browser } from "playwright";
import { pathToFileURL } from "node:url";
import { BrowserSlot, executeAction, expandMatrix, globalDeviceRegistry, PlaywrightControl, ScanConfigSchema, snapshotPage,
  type AgentAction, type CaptureRenderConfig, type DeviceTarget, type ScanConfigInput } from "@pixelsentinel/core";
import type { RunBudget } from "@pixelsentinel/core";
import { loadSourceMap, originalPositionFor, urlToRepoFile } from "./sourcemap-decode.js";

export interface CdpRuleLocation {
  file: string;
  line: number;
  column?: number;
  selectorText: string;
  method: "css-sourcemap" | "css-cdp";
}

interface SheetHeader {
  styleSheetId: string;
  sourceURL: string;
  sourceMapURL?: string;
  startLine: number;
  startColumn: number;
  isInline: boolean;
  ownerNode?: number;
}

/**
 * Ask Chromium which stylesheet rules actually style the element (CSS.getMatchedStylesForNode), then
 * follow the stylesheet's source map back to the authored file. Works for bundled / preprocessed CSS
 * (Vite, webpack, Sass, CSS modules) where grepping the served CSS would find nothing.
 */
export class CdpCssResolver {
  private browser: Browser | null = null;
  private browserSlot = new BrowserSlot();
  private closed = false;

  constructor(
    private readonly liveUrl: string,
    private readonly repoRoot: string,
    private readonly projectDirs: string[],
    private readonly scanConfig?: ScanConfigInput,
    private readonly budget?: RunBudget
  ) {}

  async resolve(selector: string, opts: { deviceId?: string; renderId?: string; renderConfig?: CaptureRenderConfig; actions?: unknown[] } = {}): Promise<CdpRuleLocation[]> {
    this.budget?.assertActive();
    if (this.closed) return [];
    const device = this.resolveCaptureTarget(opts);
    // Unknown geometry cannot establish which responsive rules affected the finding.
    if (!device) return [];
    if (!this.browser) this.browser = await this.browserSlot.get(() => chromium.launch({ headless: true, timeout: Math.min(30000, this.budget?.remainingMs() ?? 30000) }));
    this.budget?.assertActive();
    if (this.closed) return [];
    const context = await this.browser.newContext({
      viewport: device.viewport,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      deviceScaleFactor: device.deviceScaleFactor,
      userAgent: device.userAgent,
      colorScheme: device.modifiers?.darkMode ? "dark" : undefined
    });
    const page = await context.newPage();
    try {
      const cdp = await context.newCDPSession(page);
      const sheets = new Map<string, SheetHeader>();
      cdp.on("CSS.styleSheetAdded", (e: { header: SheetHeader }) => sheets.set(e.header.styleSheetId, e.header));
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      await page.goto(this.liveUrl, { waitUntil: "networkidle", timeout: 30000 });
      let currentTarget = device;
      const control = new PlaywrightControl(page, () => currentTarget, (next) => { currentTarget = next; });
      const session = { page, control, get target() { return currentTarget; }, warnings: [], id: "cdp", close: async () => {} };
      // Reproduce the exploration state the finding was found in
      for (const recorded of (opts.actions ?? []) as AgentAction[]) {
        if (recorded.type !== "done") this.budget?.consumeAction();
        let action = recorded;
        if (action.type === "navigate") {
          const original = new URL(action.url, this.liveUrl);
          if (["localhost", "127.0.0.1", "[::1]"].includes(original.hostname)) action = { ...action, url: new URL(original.pathname + original.search + original.hash, this.liveUrl).href };
        }
        const replayed = await executeAction(session, action, await snapshotPage(page));
        if (!replayed.success) return [];
      }
      const { root } = (await cdp.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
      const { nodeId } = (await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector })) as { nodeId: number };
      if (!nodeId) return [];
      const matched = (await cdp.send("CSS.getMatchedStylesForNode", { nodeId })) as {
        matchedCSSRules?: Array<{
          rule: {
            styleSheetId?: string;
            origin: string;
            selectorList: { text: string };
            style: { range?: { startLine: number; startColumn: number } };
          };
        }>;
      };
      const out: CdpRuleLocation[] = [];
      // Later rules win the cascade, so report them first
      for (const { rule } of [...(matched.matchedCSSRules ?? [])].reverse()) {
        if (rule.origin !== "regular" || !rule.styleSheetId || !rule.style.range) continue;
        const header = sheets.get(rule.styleSheetId);
        if (!header) continue;
        let sourceURL = header.sourceURL;
        if (!sourceURL && header.ownerNode) {
          // Vite injects CSS in a style node. CDP has its sourcemap but leaves sourceURL empty.
          const { node } = await cdp.send("DOM.describeNode", { backendNodeId: header.ownerNode });
          const attributes: string[] = node.attributes ?? [];
          const index = attributes.indexOf("data-vite-dev-id");
          if (index >= 0) sourceURL = pathToFileURL(attributes[index + 1]).href;
        }
        sourceURL ||= this.liveUrl;
        // range is relative to the stylesheet text; inline <style> sheets are offset inside the document
        const genLine = rule.style.range.startLine + 1;
        const genCol = rule.style.range.startColumn;
        const docLine = header.isInline ? header.startLine + genLine : genLine;

        if (header.sourceMapURL) {
          const map = await loadSourceMap(header.sourceMapURL, sourceURL, this.budget?.signal);
          const pos = map && originalPositionFor(map, genLine, genCol);
          const file = pos && urlToRepoFile(new URL(pos.source, sourceURL).toString(), this.repoRoot, this.projectDirs);
          if (file && pos) {
            out.push({ file, line: pos.line, column: pos.column, selectorText: rule.selectorList.text, method: "css-sourcemap" });
          }
          // Generated lines are not authored locations when a source map leaves
          // this span unmapped or cannot be resolved. Let source fallback handle it.
          continue;
        }
        let file = urlToRepoFile(sourceURL, this.repoRoot, this.projectDirs);
        if (!file && header.isInline && new URL(sourceURL).pathname.endsWith("/")) {
          file = urlToRepoFile(new URL("index.html", sourceURL).href, this.repoRoot, this.projectDirs);
        }
        if (file) out.push({ file, line: docLine, column: genCol + (header.isInline && genLine === 1 ? header.startColumn : 0), selectorText: rule.selectorList.text, method: "css-cdp" });
      }
      return out;
    } catch {
      return [];
    } finally {
      await context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.closed = true; this.browser = null;
    await this.browserSlot.close();
  }

  private resolveCaptureTarget(opts: { deviceId?: string; renderId?: string; renderConfig?: CaptureRenderConfig }): DeviceTarget | null {
    if (opts.renderConfig) return opts.renderConfig.deviceTarget ?? globalDeviceRegistry.resolveTarget(opts.renderConfig);
    if (this.scanConfig) {
      const config = ScanConfigSchema.parse(this.scanConfig);
      const custom = config.devices?.find((item) => typeof item !== "string" && item.id === opts.deviceId);
      if (custom) return globalDeviceRegistry.resolveTarget(custom);
      const viewport = expandMatrix(config).find((item) => item.renderId === opts.renderId);
      if (viewport) return globalDeviceRegistry.resolveTarget(viewport);
    }
    try { return opts.deviceId ? globalDeviceRegistry.resolveTarget(opts.deviceId) : null; }
    catch { return null; }
  }
}

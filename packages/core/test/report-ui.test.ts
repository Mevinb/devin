import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { expect, it } from "vitest";
import { scan } from "../src/scanner.js";
import { writeHtmlReport } from "../src/report/html-report.js";
import { startStaticServer } from "../src/target/static-server.js";
import { RunBudget } from "../src/budget.js";

it("renders saved state/trace/device-frame data and treats scanned page text and selectors as inert text", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "ps-report-ui-"));
  const browser = await chromium.launch({ headless: true });
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    const report = await scan({ target: path.resolve(__dirname, "../../../fixtures/clean"),
      viewports: [{ name: "Renderer fixture", width: 640, height: 480 }], vision: { enabled: false }, extraWaitMs: 0, output: { dir: output } });
    const item = report.matrix[0];
    // Usage renderer fixture: this unknown-cost receipt is synthetic, not live API evidence.
    const budget = new RunBudget(); await budget.request("vision", "unpriced-renderer-fixture", 1, async () => ({}));
    report.usage = budget.snapshot(); budget.dispose();
    const malicious = '<img src=x onerror="window.__reportExecuted=true">';
    const selector = 'input[data-label="O\'Reilly"]';
    item.stateName = "Modal: " + malicious;
    item.trace = ["tap #menu", "type O'Reilly into a form"];
    // Renderer fixture only: this tests saved metadata, not a claim of a real Android run.
    item.device = { id: "renderer:device-frame", name: "Device-frame renderer fixture", runtime: "android", fidelity: "webview" };
    item.deviceScreenshotRelPath = "device-frame-fixture.png";
    item.findings = [{ id: "fixture-finding", type: "runtime-error", severity: "warning", confidence: 1, sources: ["heuristic"],
      description: malicious, renderId: item.renderId, bbox: { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 },
      elements: [{ selector }] }];
    item.status = "fail"; item.findingsCount = { critical: 0, warning: 1, info: 0, total: 1 };
    await sharp({ create: { width: 400, height: 600, channels: 3, background: "#183d34" } }).png().toFile(path.join(output, item.deviceScreenshotRelPath));
    await writeHtmlReport(report, output); server = await startStaticServer(output);
    const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
    const exceptions: string[] = []; page.on("pageerror", (error) => exceptions.push(error.message));
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(server.url).origin });
    await page.goto(server.url + "report.html");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(await page.locator(".render-title").textContent()).toBe("Renderer fixture");
    expect(await page.locator(".state-name").textContent()).toBe("Modal: " + malicious);
    expect(await page.locator(".fidelity-badge").textContent()).toBe("webview");
    const usage = page.getByRole("region", { name: "AI usage and budget", exact: true });
    expect(await usage.textContent()).toContain("Total cost is unknown");
    expect(await usage.textContent()).toContain("1 requests lack usage receipts");
    expect(await usage.locator("tbody tr").count()).toBe(4);
    await page.locator(".render-card").click();
    expect(await page.locator(".finding-desc").textContent()).toBe(malicious);
    expect(await page.locator(".trace-box").textContent()).toContain("type O'Reilly");
    const copy = page.getByRole("button", { name: selector, exact: true });
    await copy.click(); await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selector);
    const pageImage = await page.locator("#viewerImg").getAttribute("src");
    await page.getByRole("button", { name: "Device frame", exact: true }).click();
    expect(await page.locator("#viewerImg").getAttribute("src")).toBe("device-frame-fixture.png");
    await page.getByRole("button", { name: "Annotated page", exact: true }).click();
    expect(await page.locator("#viewerImg").getAttribute("src")).toBe(pageImage);
    expect(await page.evaluate(() => (window as unknown as { __reportExecuted?: boolean }).__reportExecuted)).toBeUndefined();
    expect(exceptions).toEqual([]);
  } finally { await browser.close(); await server?.cleanup(); await fs.rm(output, { recursive: true, force: true }); }
}, 20000);

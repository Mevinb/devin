import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createServer, type ScanJob } from "../src/index.js";

const root = path.resolve(__dirname, "../../..");
const exec = promisify(execFile);
const evidence = "/tmp/pixelsentinel-qa";

describe("Rendered dashboard and standalone report", () => {
  let temp: string, project: string, url: string;
  let browser: Browser, server: ReturnType<typeof createServer>;
  const errors: string[] = [];
  beforeAll(async () => {
    vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("PIXELSENTINEL_DEVICES", "approximate");
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-dashboard-"));
    project = path.join(temp, "project"); await fs.mkdir(project); await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(project, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0} #wide {width:3000px;height:50px}</style></head><body><div id="wide">Overflow</div></body></html>\n');
    await exec("git", ["init", "-q", project]); await exec("git", ["add", "."], { cwd: project });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: project });
    server = createServer({ outputDir: path.join(temp, "artifacts"), logger: false });
    url = await server.listen({ port: 0, host: "127.0.0.1" });
    browser = await chromium.launch({ headless: true });
  }, 20000);
  afterAll(async () => { await browser?.close(); await server?.close(); await fs.rm(temp, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  async function pageAt(width = 1440): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(url);
    return page;
  }
  async function assertImages(page: Page) {
    await vi.waitFor(async () => expect(await page.evaluate(() => [...document.images].filter((image) => image.checkVisibility() && (!image.complete || image.naturalWidth === 0)).map((image) => ({ src: image.src, loading: image.loading, complete: image.complete, visible: image.checkVisibility(), width: image.getBoundingClientRect().width, top: image.getBoundingClientRect().top })))).toEqual([]), { timeout: 5000 });
  }
  async function assertWidth(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }

  it("launches a real scan, shows its verified diff/evidence, filters states and works on a phone viewport", async () => {
    const page = await pageAt();
    expect(await page.title()).toContain("PixelSentinel");
    expect(await page.getByRole("heading", { name: "New device and state scan" }).isVisible()).toBe(true);
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
    await page.getByLabel("Scan target", { exact: true }).fill(project);
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page.getByLabel("OpenAI vision", { exact: true }).uncheck();
    await page.getByLabel("Propose source fixes", { exact: true }).check();
    const request = page.waitForRequest((item) => item.url().endsWith("/api/scans") && item.method() === "POST");
    await page.getByRole("button", { name: "Run scan", exact: true }).click();
    const submitted = (await request).postDataJSON();
    expect(submitted.devices).toEqual(["chromium:desktop-1080p"]);
    expect(submitted.proposeFixes).toBe(true);
    await page.getByRole("region", { name: "Scan results", exact: true }).waitFor({ timeout: 20000 });
    const jobs = (await server.inject("/api/scans")).json() as ScanJob[];
    const job = jobs.find((item) => item.target === project)!;
    expect(job.status, job.error).toBe("completed");
    expect(await page.locator(".device-fidelity").textContent()).toBe("real");
    expect(await page.getByRole("region", { name: "Proposed fixes", exact: true }).textContent()).toContain("verified");
    await assertImages(page); await assertWidth(page);
    await page.screenshot({ path: path.join(evidence, "dashboard-desktop.png"), fullPage: true });
    await page.locator(".proposal-row").click();
    const dialog = page.getByRole("dialog", { name: "Proposed patch for index.html" });
    await dialog.waitFor();
    expect(await dialog.getByLabel("Unified diff").textContent()).toBe(job.report!.fixes![0].diff);
    expect(await dialog.textContent()).toContain("Original finding reproduced");
    await dialog.locator("summary").click(); await assertImages(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
    await dialog.getByRole("button", { name: "Copy git apply command" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(job.report!.fixes![0].diffRelPath);
    await page.screenshot({ path: path.join(evidence, "verified-patch.png"), fullPage: false });
    await dialog.getByRole("button", { name: "Close patch" }).click();
    await page.getByRole("button", { name: "Clean (0)", exact: true }).click();
    expect(await page.locator(".device-card").count()).toBe(0);
    expect(await page.getByText("No states match this filter.", { exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "All (1)", exact: true }).click();
    await page.setViewportSize({ width: 320, height: 844 }); await assertWidth(page);
    expect((await page.getByRole("button", { name: "Run scan", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.setViewportSize({ width: 390, height: 844 }); await assertWidth(page); await assertImages(page);
    await page.screenshot({ path: path.join(evidence, "dashboard-mobile.png"), fullPage: true });
    await page.locator(".device-card").click();
    const inspector = page.getByRole("dialog", { name: /Inspector:/ }); await inspector.waitFor();
    await assertWidth(page); await assertImages(page);
    expect(await inspector.getByText("horizontal-overflow", { exact: true }).isVisible()).toBe(true);
    expect(await inspector.getByRole("button", { name: "Device frame", exact: true }).count()).toBe(0);
    await page.screenshot({ path: path.join(evidence, "inspector-mobile.png"), fullPage: false });
    await page.keyboard.press("Escape"); expect(await page.getByRole("dialog").count()).toBe(0);
    expect((await exec("git", ["status", "--porcelain"], { cwd: project })).stdout).toBe("");
    await page.close();
  }, 40000);

  it("renders actual exploration events and state names with reproduction steps", async () => {
    const page = await pageAt();
    await page.getByLabel("Scan target", { exact: true }).fill(path.join(root, "fixtures/flows"));
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page.getByLabel("OpenAI vision", { exact: true }).uncheck();
    await page.getByLabel("Explore application states", { exact: true }).check();
    await page.getByLabel("Offline exploration agent", { exact: true }).check();
    await page.getByLabel("Step limit", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Run scan", exact: true }).click();
    await page.getByRole("region", { name: "Scan results", exact: true }).waitFor({ timeout: 20000 });
    expect(await page.getByLabel("Agent action stream").textContent()).toContain('"type":"tap"');
    expect(await page.locator(".state-name").count()).toBeGreaterThan(1);
    await assertImages(page);
    await page.locator(".device-card").last().click();
    expect(await page.getByRole("dialog").textContent()).toContain("How to reproduce");
    await page.keyboard.press("Escape");
    await page.screenshot({ path: path.join(evidence, "exploration-states.png"), fullPage: true });
    await page.close();
  }, 30000);

  it("standalone HTML shows actual fidelity and patches and preserves inspector/filter interactions", async () => {
    const jobs = (await server.inject("/api/scans")).json() as ScanJob[];
    const job = jobs.find((item) => item.target === project)!;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(url + job.artifactBaseUrl + "report.html");
    expect(await page.title()).toContain("PixelSentinel");
    expect(await page.locator(".fidelity-badge").textContent()).toBe("real");
    expect(await page.getByRole("region", { name: "AI usage and budget", exact: true }).textContent()).toContain("$0.000000 estimated");
    await page.locator("#fixesPanel > details > summary").click();
    expect(await page.locator("#fixesPanel pre").textContent()).toBe(job.report!.fixes![0].diff);
    await page.getByRole("button", { name: /^Clean Only/ }).click(); expect(await page.locator(".render-card").count()).toBe(0);
    await page.getByRole("button", { name: /^All Targets/ }).click();
    await page.locator(".render-card").click();
    expect(await page.getByRole("dialog").isVisible()).toBe(true);
    expect(await page.locator("#findingsSidebar").textContent()).toContain("horizontal-overflow");
    await page.getByRole("button", { name: "Close inspector" }).click();
    await page.setViewportSize({ width: 390, height: 844 }); await assertWidth(page); await assertImages(page);
    await page.screenshot({ path: path.join(evidence, "standalone-mobile.png"), fullPage: true });
    await page.locator(".render-card").click(); await assertWidth(page); await assertImages(page);
    await page.keyboard.press("Escape"); expect(await page.getByRole("dialog").isVisible()).toBe(false);
    await page.close();
  }, 15000);

  it("submits shared budget controls and renders a retained offline stop on desktop and mobile", async () => {
    const page = await pageAt();
    await page.getByLabel("Scan target", { exact: true }).fill(path.join(root, "fixtures/flows"));
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page.getByLabel("OpenAI vision", { exact: true }).uncheck();
    await page.getByLabel("Explore application states", { exact: true }).check();
    await page.getByLabel("Offline exploration agent", { exact: true }).check();
    await page.getByText("Job limits and model pricing", { exact: true }).click();
    await page.getByLabel("Shared action cap", { exact: true }).fill("0");
    await page.getByLabel("Shared token cap", { exact: true }).fill("10000");
    await page.getByLabel("Shared cost cap", { exact: true }).fill("1");
    // Illustrative test rates only; no paid model request is made.
    await page.getByLabel("Model input token ceiling", { exact: true }).fill("100000");
    await page.getByLabel("Input price per million", { exact: true }).fill("1");
    await page.getByLabel("Output price per million", { exact: true }).fill("2");
    const request = page.waitForRequest((item) => item.url().endsWith("/api/scans") && item.method() === "POST");
    await page.getByRole("button", { name: "Run scan", exact: true }).click();
    expect((await request).postDataJSON().budget).toMatchObject({ maxActions: 0, maxTokens: 10000, maxCostUsd: 1,
      models: { "gpt-4o": { contextTokens: 100000, inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } });
    await page.getByRole("region", { name: "Scan results", exact: true }).waitFor({ timeout: 20000 });
    const meter = page.getByRole("region", { name: "AI usage and budget", exact: true });
    expect(await meter.textContent()).toContain("Reached the shared action budget");
    expect(await meter.locator("tbody tr").count()).toBe(4);
    expect(await meter.textContent()).toContain("$0.000000 estimated");
    await meter.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, "budget-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 320, height: 844 }); await assertWidth(page);
    await meter.scrollIntoViewIfNeeded();
    // Let Chromium repaint the backdrop-filter layer after the viewport resize.
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(evidence, "budget-mobile.png"), animations: "disabled" });
    await page.close();
  }, 30000);

  it("releases a missing scan after a server restart and can immediately run another scan", async () => {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/scans/job-before-restart{,/**}", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Scan job not found" }) }));
    await page.route("**/api/scans", (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-before-restart" }) }) : route.continue());
    await page.goto(url);
    expect(await page.getByLabel("Device IDs", { exact: true }).inputValue()).toBe("chromium:desktop-1080p");
    expect(await page.getByLabel("OpenAI vision", { exact: true }).isChecked()).toBe(false);
    await page.getByLabel("Scan target", { exact: true }).fill(project);
    await page.getByRole("button", { name: "Run scan", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "That scan is no longer available" }).waitFor();
    expect(await page.getByRole("button", { name: "Run scan", exact: true }).isEnabled()).toBe(true);
    await page.unroute("**/api/scans");
    const request = page.waitForRequest((item) => item.url().endsWith("/api/scans") && item.method() === "POST");
    await page.getByRole("button", { name: "Run scan", exact: true }).click();
    expect((await request).postDataJSON().concurrency).toBe(1);
    await page.getByRole("region", { name: "Scan results", exact: true }).waitFor({ timeout: 20000 });
    expect(await page.getByRole("button", { name: "Run scan", exact: true }).isEnabled()).toBe(true);
    await page.close();
  }, 30000);

  it("has no application errors in the tested rendered flows", () => { expect(errors).toEqual([]); });
});

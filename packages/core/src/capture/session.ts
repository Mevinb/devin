import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Page } from "playwright";
import type { ScanConfig } from "../config/schema.js";
import type { DeviceSession, DeviceTarget } from "../runtime/types.js";
import { extractDOMSnapshotInBrowser } from "./dom-snapshot.js";
import type {
  CaptureMetadata,
  CaptureRenderConfig,
  CaptureResult,
  DOMSnapshot,
  FailedRequest,
  KeyboardProbe
} from "./types.js";

export const DISABLE_ANIMATIONS_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
`;

export interface PageMonitor {
  consoleErrors: string[];
  failedRequests: FailedRequest[];
  pageErrors: string[];
  /** Drain errors collected since the last call (used per exploration state). */
  drain(): { consoleErrors: string[]; failedRequests: FailedRequest[]; pageErrors: string[] };
  detach(): void;
}

export function attachPageMonitor(page: Page): PageMonitor {
  const m = { consoleErrors: [] as string[], failedRequests: [] as FailedRequest[], pageErrors: [] as string[] };
  let mark = { c: 0, f: 0, p: 0 };
  const onConsole = (msg: import("playwright").ConsoleMessage) => {
    if (msg.type() === "error") m.consoleErrors.push(msg.text());
  };
  // Keep the first script location so the fixer can map the exception to a source line
  const onPageError = (err: Error) => {
    const loc = err.stack?.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
    m.pageErrors.push(loc ? `${err.message} @ ${loc[1]}:${loc[2]}:${loc[3]}` : err.message);
  };
  const onFailed = (req: import("playwright").Request) =>
    m.failedRequests.push({ url: req.url(), error: req.failure()?.errorText || "Unknown network failure" });
  const onResponse = (res: import("playwright").Response) => {
    if (res.status() >= 400) m.failedRequests.push({ url: res.url(), status: res.status() });
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onFailed);
  page.on("response", onResponse);
  return {
    ...m,
    drain() {
      const out = {
        consoleErrors: m.consoleErrors.slice(mark.c),
        failedRequests: m.failedRequests.slice(mark.f),
        pageErrors: m.pageErrors.slice(mark.p)
      };
      mark = { c: m.consoleErrors.length, f: m.failedRequests.length, p: m.pageErrors.length };
      return out;
    },
    detach() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onFailed);
      page.off("response", onResponse);
    }
  };
}

export function renderIdForTarget(target: DeviceTarget, suffix?: string): string {
  const base = target.id.replace(/[^a-zA-Z0-9_.@-]/g, "_");
  return suffix ? `${base}__${suffix.replace(/[^a-zA-Z0-9_.-]/g, "_")}` : base;
}

/** Render config describing what the device actually rendered (measured viewport, not the nominal one). */
export function renderConfigForTarget(target: DeviceTarget, renderId: string, snapshot?: DOMSnapshot): CaptureRenderConfig {
  const inner = snapshot?.document.innerWidth || target.viewport.width;
  // Mobile browsers zoom out (widening innerWidth) when content overflows; judge layout against the screen.
  const screen = snapshot?.document.screenWidth;
  const width = target.isMobile && screen && screen < inner ? screen : inner;
  const height = snapshot?.document.innerHeight || target.viewport.height;
  return {
    renderId,
    name: target.name,
    width,
    height,
    deviceScaleFactor: snapshot?.document.devicePixelRatio || target.deviceScaleFactor,
    isMobile: target.isMobile,
    hasTouch: target.hasTouch,
    orientation: height >= width ? "portrait" : "landscape",
    deviceTarget: target
  };
}

export async function stabilizePage(page: Page, extraWaitMs: number): Promise<void> {
  await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS }).catch(() => {});
  await page
    .evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    })
    .catch(() => {});
  if (extraWaitMs > 0) await page.waitForTimeout(extraWaitMs);
}

export async function snapshotPage(page: Page): Promise<DOMSnapshot> {
  // esbuild/tsx keepNames wraps nested functions in __name(); provide it inside the page
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
  return (await page.evaluate(extractDOMSnapshotInBrowser)) as DOMSnapshot;
}

async function pageScreenshot(page: Page, fullPage: boolean): Promise<{ buffer: Buffer; fullPage: boolean }> {
  try {
    return { buffer: await page.screenshot({ fullPage, type: "png", timeout: 30000 }), fullPage };
  } catch (err) {
    if (!fullPage) throw err;
    return { buffer: await page.screenshot({ fullPage: false, type: "png", timeout: 30000 }), fullPage: false };
  }
}

/**
 * Focus bottom-anchored inputs on a real device, let the real IME open, and measure whether the
 * input stays inside the visual viewport. Replaces the 40%-keyboard simulation on real hardware.
 */
async function probeSoftKeyboard(session: DeviceSession, snapshot: DOMSnapshot, renderDir: string): Promise<KeyboardProbe[]> {
  const { page, control, target } = session;
  if (target.fidelity === "approximate" || !target.isMobile || target.isTV || !control.deviceScreenshot) return [];
  const vh = snapshot.document.innerHeight;
  const scrollY = snapshot.document.scrollY ?? 0;
  const byId = new Map(snapshot.elements.map((e) => [e.id, e]));
  const isAnchored = (id: string | null): boolean => {
    for (let cur = id ? byId.get(id) : undefined; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      if (cur.styles.position === "fixed" || cur.styles.position === "sticky") return true;
    }
    return false;
  };
  const candidates = snapshot.elements
    .filter((e) => ["input", "textarea"].includes(e.tagName) && e.rect.width > 0 && e.rect.height > 0)
    .filter((e) => isAnchored(e.id) || e.rect.top - scrollY > vh * 0.55)
    .slice(0, 2);

  const probes: KeyboardProbe[] = [];
  for (const [i, el] of candidates.entries()) {
    try {
      const loc = page.locator(el.selector).first();
      const editable = await loc.evaluate((node) => node instanceof HTMLTextAreaElement && !node.disabled && !node.readOnly ||
        node instanceof HTMLInputElement && !node.disabled && !node.readOnly && ["text", "search", "email", "url", "tel", "number", "password"].includes(node.type));
      if (!editable) continue;
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      const baselineHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
      const settle = () => page.evaluate(async (sel) => {
        const measure = () => {
          const node = document.querySelector(sel), r = node?.getBoundingClientRect(), vv = window.visualViewport;
          return { inputBottom: r ? r.bottom : 0, visibleBottom: vv ? vv.offsetTop + vv.height : window.innerHeight,
            layoutHeight: window.innerHeight, vvHeight: vv ? vv.height : window.innerHeight, focused: document.activeElement === node };
        };
        let previous = "", stableSamples = 0, latest = measure();
        // Native IME animation and Chrome's automatic pan can finish at different times.
        for (let sample = 0; sample < 15; sample++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          latest = measure();
          const key = JSON.stringify(Object.values(latest).map((value) => typeof value === "number" ? Math.round(value) : value));
          stableSamples = key === previous ? stableSamples + 1 : 0;
          if (stableSamples >= 4) return { ...latest, stable: true };
          previous = key;
        }
        return { ...latest, stable: false };
      }, el.selector);
      let attempts = 0, m: Awaited<ReturnType<typeof settle>> | undefined;
      for (; attempts < 2; ) {
        const box = await loc.boundingBox();
        if (!box) break;
        await control.tap(box.x + box.width / 2, box.y + box.height / 2);
        attempts++;
        // An early resize can disappear before the native IME settles. Retry
        // based on the settled measurement, not the first animation sample.
        await page.waitForFunction(({ selector, baselineHeight }) => {
          const height = window.visualViewport?.height ?? window.innerHeight;
          return document.activeElement === document.querySelector(selector) &&
            (height < window.innerHeight - 80 || height < baselineHeight - 80);
        }, { selector: el.selector, baselineHeight }, { timeout: 1800 }).catch(() => {});
        m = await settle();
        if (m.stable && m.focused && (m.vvHeight < m.layoutHeight - 80 || m.vvHeight < baselineHeight - 80)) break;
      }
      if (!m) continue;
      const keyboardShown = m.focused && (m.vvHeight < m.layoutHeight - 80 || m.vvHeight < baselineHeight - 80);
      const shot = await control.deviceScreenshot();
      let screenshotPath: string | undefined;
      if (shot) {
        screenshotPath = path.join(renderDir, `keyboard-${i}.png`);
        await fs.writeFile(screenshotPath, shot);
      }
      probes.push({
        selector: el.selector,
        elementId: el.id,
        inputBottom: Math.round(m.inputBottom),
        visibleBottom: Math.round(m.visibleBottom),
        keyboardShown,
        focused: m.focused,
        attempts,
        stable: m.stable,
        obscured: m.stable && keyboardShown && m.inputBottom > m.visibleBottom + 1,
        screenshotPath
      });
    } catch {
      // probing is best effort
    } finally {
      await control.setKeyboardVisible(false).catch(() => {});
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {});
      await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: snapshot.document.scrollX ?? 0, y: scrollY }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  return probes;
}

export interface BuildCaptureOptions {
  session: DeviceSession;
  renderId: string;
  renderDir: string;
  url: string;
  fullPage: boolean;
  monitor?: { consoleErrors: string[]; failedRequests: FailedRequest[]; pageErrors: string[] };
  probeKeyboard?: boolean;
  snapshot?: DOMSnapshot;
}

/** Capture the page in its current state (used by scans, exploration states, and replays). */
export async function captureCurrentState(opts: BuildCaptureOptions): Promise<CaptureResult> {
  const { session, renderId, renderDir, fullPage } = opts;
  await fs.mkdir(renderDir, { recursive: true });
  const domSnapshot = opts.snapshot ?? (await snapshotPage(session.page));
  const shot = await pageScreenshot(session.page, fullPage);
  const screenshotBuffer = shot.buffer;
  const pixels = await sharp(screenshotBuffer).metadata();
  const deviceShot = session.control.deviceScreenshot ? await session.control.deviceScreenshot() : null;
  const keyboardProbes = opts.probeKeyboard ? await probeSoftKeyboard(session, domSnapshot, renderDir) : undefined;

  const screenshotPath = path.join(renderDir, "screenshot.png");
  const domPath = path.join(renderDir, "dom.json");
  const metaPath = path.join(renderDir, "meta.json");
  let deviceScreenshotPath: string | undefined;
  await fs.writeFile(screenshotPath, screenshotBuffer);
  await fs.writeFile(domPath, JSON.stringify(domSnapshot, null, 2), "utf8");
  if (deviceShot) {
    deviceScreenshotPath = path.join(renderDir, "device.png");
    await fs.writeFile(deviceScreenshotPath, deviceShot);
  }

  const target = session.target;
  const renderConfig = renderConfigForTarget(target, renderId, domSnapshot);
  const metadata: CaptureMetadata = {
    renderId,
    viewport: renderConfig,
    url: session.page.url(),
    timestamp: new Date().toISOString(),
    consoleErrors: opts.monitor?.consoleErrors ?? [],
    failedRequests: opts.monitor?.failedRequests ?? [],
    pageErrors: opts.monitor?.pageErrors ?? [],
    hasHorizontalScroll: domSnapshot.document.scrollWidth > domSnapshot.document.innerWidth + 2,
    screenshotPath,
    screenshotGeometry: {
      pixelWidth: pixels.width!, pixelHeight: pixels.height!,
      cssWidth: shot.fullPage ? Math.max(domSnapshot.document.scrollWidth, domSnapshot.document.innerWidth) : domSnapshot.document.innerWidth,
      cssHeight: shot.fullPage ? Math.max(domSnapshot.document.scrollHeight, domSnapshot.document.innerHeight) : domSnapshot.document.innerHeight,
      originX: shot.fullPage ? 0 : domSnapshot.document.scrollX ?? 0,
      originY: shot.fullPage ? 0 : domSnapshot.document.scrollY ?? 0,
      fullPage: shot.fullPage
    },
    domPath,
    deviceScreenshotPath,
    keyboardProbes,
    dimensions: {
      viewportWidth: domSnapshot.document.innerWidth,
      viewportHeight: domSnapshot.document.innerHeight,
      pageWidth: domSnapshot.document.scrollWidth,
      pageHeight: domSnapshot.document.scrollHeight
    },
    device: {
      id: target.id,
      name: target.name,
      runtime: target.runtime,
      fidelity: target.fidelity,
      browser: target.fidelity === "approximate" ? target.engine ?? "chromium" : target.android?.browser ?? target.windows?.browser ?? target.engine ?? "chromium",
      orientation: renderConfig.orientation,
      modifiers: target.modifiers,
      info: session.deviceInfo
    },
    warnings: session.warnings.length ? [...session.warnings] : undefined
  };
  await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), "utf8");

  return { renderConfig, screenshotBuffer, screenshotPath, domSnapshot, domPath, metadata, metaPath };
}

/** Navigate a device session to the target and capture it through the Phase 1 pipeline. */
export async function captureSession(
  session: DeviceSession,
  url: string,
  scanConfig: ScanConfig,
  outputBaseDir: string,
  renderId = renderIdForTarget(session.target)
): Promise<CaptureResult> {
  const renderDir = path.join(outputBaseDir, "renders", renderId);
  const monitor = attachPageMonitor(session.page);
  try {
    const deviceUrl = session.prepareUrl ? await session.prepareUrl(url) : url;
    await session.page.goto(deviceUrl, { waitUntil: scanConfig.waitUntil, timeout: 60000 });
    await stabilizePage(session.page, scanConfig.extraWaitMs);
    if (session.target.runtime === "android" && "refreshViewport" in session.control) {
      await (session.control as { refreshViewport(): Promise<void> }).refreshViewport();
    }
    return await captureCurrentState({
      session,
      renderId,
      renderDir,
      url: deviceUrl,
      fullPage: scanConfig.fullPage,
      monitor,
      probeKeyboard: true
    });
  } finally {
    monitor.detach();
  }
}

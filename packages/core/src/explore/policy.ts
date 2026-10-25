import path from "node:path";
import type { CDPSession, Page, Route } from "playwright";
import type { DOMSnapshot } from "../capture/types.js";
import type { AgentAction, ExploreConfig } from "./types.js";

export const DESTRUCTIVE_LABELS = ["delete", "remove", "destroy", "drop database", "cancel subscription", "purchase", "buy now", "pay", "send", "place order", "sign out", "logout"];

/** One policy for pilot actions, deterministic replay and recovery; prompts are not enforcement. */
export class ActionPolicy {
  readonly violations: string[] = [];
  private readonly start: URL;
  private readonly allowed: Set<string>;
  private readonly attachments = new WeakMap<Page, Promise<() => Promise<void>>>();
  constructor(startUrl: string, private readonly config: Partial<ExploreConfig> = {}) {
    this.start = new URL(startUrl);
    this.allowed = new Set([this.start.origin, ...(config.allowedOrigins ?? []).map((value) => {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(`Invalid allowed origin: ${value}`);
      return url.origin;
    })]);
  }

  allowsUrl(value: string, base = this.start.href): boolean {
    try {
      const url = new URL(value, base);
      if (url.username || url.password) return false;
      if (url.protocol === "file:" && this.start.protocol === "file:") return path.dirname(url.pathname) === path.dirname(this.start.pathname);
      return /^https?:$/.test(url.protocol) && (this.config.allowExternalNavigation === true || this.allowed.has(url.origin));
    } catch { return false; }
  }

  /** Keep scripted navigation and HTTP redirects inside the allow-list too. */
  async attach(page: Page): Promise<() => Promise<void>> {
    const existing = this.attachments.get(page);
    if (existing) return existing;
    const attachment = this.attachOnce(page);
    this.attachments.set(page, attachment);
    try { return await attachment; } catch (error) { this.attachments.delete(page); throw error; }
  }

  private async attachOnce(page: Page): Promise<() => Promise<void>> {
    const context = page.context();
    let cdp: CDPSession | undefined;
    try {
      cdp = await context.newCDPSession(page);
      cdp.on("Fetch.requestPaused", (event) => {
        const location = event.responseHeaders?.find((header: { name: string; value: string }) => header.name.toLowerCase() === "location")?.value;
        const redirect = [301, 302, 303, 307, 308].includes(event.responseStatusCode ?? 0);
        const blocked = redirect && location && !this.allowsUrl(location, event.request.url);
        if (blocked) this.violations.push("Redirect blocked: destination is outside the allowed origins");
        void cdp!.send(blocked ? "Fetch.failRequest" : "Fetch.continueRequest", blocked
          ? { requestId: event.requestId, errorReason: "BlockedByClient" }
          : { requestId: event.requestId }).catch(() => {});
      });
      // Playwright skips route callbacks after an HTTP redirect; inspect each response
      // before the browser follows it, without fetching documents twice or rewriting them.
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
    } catch { await cdp?.detach().catch(() => {}); cdp = undefined; }
    const handler = async (route: Route) => {
      const request = route.request();
      if (!request.isNavigationRequest()) { await route.fallback(); return; }
      try { if (request.frame().parentFrame()) { await route.fallback(); return; } } catch { /* first popup request */ }
      if (!this.allowsUrl(request.url())) {
        this.violations.push("Navigation blocked: destination is outside the allowed origins");
        await route.abort("blockedbyclient"); return;
      }
      if (!cdp && !this.config.allowExternalNavigation && /^https?:/.test(request.url())) {
        // Firefox/WebKit do not expose CDP. Fail closed on redirects rather than
        // allowing an unchecked chain to escape after Playwright stops intercepting.
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 30000 });
          try {
            const location = response.headers().location;
            if ([301, 302, 303, 307, 308].includes(response.status()) && location) {
              this.violations.push("Redirect blocked: this browser cannot enforce the navigation allow-list across redirect chains");
              await route.abort("blockedbyclient");
            } else await route.fulfill({ response });
          } finally { await response.dispose(); }
        } catch { await route.abort("failed").catch(() => {}); }
        return;
      }
      await route.fallback();
    };
    await context.route("**/*", handler);
    const onClose = () => { void detach().catch(() => {}); };
    const detach = async () => { page.off("close", onClose); this.attachments.delete(page); await cdp?.detach().catch(() => {}); await context.unroute("**/*", handler); };
    page.once("close", onClose);
    return detach;
  }

  async check(page: Page, action: AgentAction, snapshot: DOMSnapshot, pointOverride?: { x: number; y: number }): Promise<string | undefined> {
    if (action.type === "navigate") return this.allowsUrl(action.url, page.url()) ? undefined : "Navigation blocked: destination is outside the allowed origins";
    if (action.type === "done") return;
    if (!this.allowsUrl(page.url())) return "Action blocked: page is outside the allowed origins";
    if (action.type === "press_key" && /(?:^|\+)(Delete|Backspace|KEYCODE_DEL|KEYCODE_FORWARD_DEL)$/.test(action.key) && !this.config.allowDestructive) {
      const editing = await page.evaluate(() => document.activeElement?.matches("input,textarea,[contenteditable=true]") ?? false);
      if (!editing) return "Destructive keyboard action blocked by exploration policy";
    }
    const activation = action.type === "press_key" && /(?:^|\+)(Enter|NumpadEnter|Space|DPAD_CENTER|KEYCODE_DPAD_CENTER|KEYCODE_ENTER)$/.test(action.key);
    if (action.type !== "tap" && action.type !== "type" && !activation) return;
    let selector: string | undefined;
    if (action.type === "tap" || action.type === "type") selector = action.selector ?? snapshot.elements.find((element) => element.id === action.elementId)?.selector;
    const point = pointOverride ?? (action.type === "tap" && action.x !== undefined && action.y !== undefined ? { x: action.x, y: action.y } : undefined);
    const info = await page.evaluate(({ selector, point, activation }) => {
      // CDP input/boundingBox coordinates are relative to the visual viewport;
      // DOM hit-testing uses the layout viewport when mobile overflow pans it.
      const found = point ? document.elementFromPoint(point.x + (window.visualViewport?.offsetLeft ?? 0), point.y + (window.visualViewport?.offsetTop ?? 0))
        : selector ? document.querySelector(selector) : activation ? document.activeElement : null;
      if (!found) return null;
      const node = found.closest("a,button,input,select,textarea,[role=button],[role=link]") ?? found;
      const input = node instanceof HTMLInputElement ? node : null;
      const form = (node instanceof HTMLButtonElement || input) ? (node as HTMLButtonElement | HTMLInputElement).form : null;
      const submit = node instanceof HTMLButtonElement && node.type === "submit" || input?.type === "submit";
      const defaultSubmit = activation && form ? form.querySelector("button[type=submit],button:not([type]),input[type=submit]") : null;
      const label = (element: Element | null) => element ? [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent,
        element instanceof HTMLInputElement && ["submit", "button", "reset"].includes(element.type) ? element.value : ""].filter(Boolean).join(" ") : "";
      const anchor = node.closest("a[href]");
      return { label: label(node) + " " + label(defaultSubmit), href: anchor?.getAttribute("href"), download: anchor?.hasAttribute("download"),
        formAction: form && (submit || activation) ? (node.getAttribute("formaction") ?? form.getAttribute("action") ?? location.href) : null,
        editable: !node.matches(":disabled,[readonly]") && node.matches("textarea,input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]),[contenteditable=true]") };
    }, { selector, point, activation });
    if (!info) return point ? "Action target not found at these coordinates" : undefined;
    if (!this.config.allowDestructive) {
      const text = info.label.toLowerCase();
      const blocked = DESTRUCTIVE_LABELS.some((word) => new RegExp(`\\b${word}\\b`, "i").test(text)) || (this.config.disallowedKeywords ?? []).some((word) => word && text.includes(word.toLowerCase()));
      if (blocked) return "Destructive action blocked by exploration policy";
    }
    if (action.type === "type" && !info.editable) return "Type action requires an editable input";
    if (info.download) return "Downloads are not exploration actions";
    if (info.href && !this.allowsUrl(info.href, page.url())) return "Link blocked: destination is outside the allowed origins";
    if (info.formAction && !this.allowsUrl(info.formAction, page.url())) return "Form blocked: destination is outside the allowed origins";
  }
}

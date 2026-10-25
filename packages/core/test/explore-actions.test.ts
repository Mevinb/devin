import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightRuntime } from "../src/runtime/playwright.js";
import { BUILTIN_DEVICES } from "../src/runtime/registry.js";
import { snapshotPage } from "../src/capture/session.js";
import { executeAction } from "../src/explore/tools.js";
import { MockExplorationAgent } from "../src/explore/mock-agent.js";
import { ActionPolicy } from "../src/explore/policy.js";
import { ExploreConfigSchema } from "../src/explore/config.js";

describe("Exploration action guards at the execution boundary", () => {
  it("returns validation errors for malformed origins rather than throwing outside Zod", () => {
    expect(ExploreConfigSchema.safeParse({ allowedOrigins: ["not a URL"] }).success).toBe(false);
    expect(ExploreConfigSchema.safeParse({ allowedOrigins: ["https://example.invalid/path"] }).success).toBe(false);
    expect(ExploreConfigSchema.safeParse({ allowedOrigins: ["https://example.invalid"] }).success).toBe(true);
  });
  let origin: string, external: string, server: http.Server, other: http.Server;
  let externalRequests = 0;
  beforeAll(async () => {
    other = http.createServer((_req, res) => { externalRequests++; res.end("outside"); });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    external = `http://127.0.0.1:${(other.address() as import("node:net").AddressInfo).port}`;
    server = http.createServer((req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { Location: external }); res.end(); return; }
      if (req.url === "/chain") { res.writeHead(302, { Location: "/redirect" }); res.end(); return; }
      if (req.url === "/internal") { res.writeHead(302, { Location: "/landing" }); res.end(); return; }
      res.setHeader("Content-Type", "text/html");
      res.end(`<button id="danger" aria-label="Delete account" onclick="document.body.dataset.deleted='yes'"><span>Profile</span></button>
        <button id="recovery">Menu: delete account</button><a id="link" href="${external}">Visit partner</a>
        <button id="script" onclick="location.href='${external}'">Open partner</button>
        <a id="redirect" href="/redirect">Redirect</a><a id="chain" href="/chain">Chain</a><input id="name"><button id="validate" onclick="document.body.dataset.validated='yes'">Validate form</button>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterAll(async () => { await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => other.close(() => resolve()))]); });

  it("blocks live accessible labels for selector/coordinate taps, keyboard activation, and mock recovery", async () => {
    const runtime = new PlaywrightRuntime(); const session = await runtime.launch(BUILTIN_DEVICES["chromium:desktop-1080p"]);
    try {
      await session.page.goto(origin); const snap = await snapshotPage(session.page);
      const selector = await executeAction(session, { type: "tap", selector: "#danger span" }, snap);
      expect(selector.success).toBe(false);
      const box = await session.page.locator("#danger").boundingBox();
      expect((await executeAction(session, { type: "tap", x: box!.x + 5, y: box!.y + 5 }, snap)).success).toBe(false);
      await session.page.locator("#danger").focus();
      expect((await executeAction(session, { type: "press_key", key: "Enter" }, snap)).success).toBe(false);
      const recovery = new MockExplorationAgent().recoverToward(snap, "delete account");
      expect((await executeAction(session, recovery, snap)).success).toBe(false);
      expect(await session.page.locator("body").getAttribute("data-deleted")).toBeNull();
      expect((await executeAction(session, { type: "tap", selector: "#validate" }, snap)).success).toBe(true);
      expect(await session.page.locator("body").getAttribute("data-validated")).toBe("yes");
    } finally { await session.close(); await runtime.shutdown(); }
  });

  it("blocks external links, explicit URLs, scripted navigations and redirect chains before external requests", async () => {
    const runtime = new PlaywrightRuntime(); const session = await runtime.launch(BUILTIN_DEVICES["chromium:desktop-1080p"]);
    try {
      externalRequests = 0;
      await session.page.goto(origin); const snap = await snapshotPage(session.page);
      for (const action of [{ type: "navigate" as const, url: external }, ...["#link", "#script", "#redirect", "#chain"].map((selector) => ({ type: "tap" as const, selector }))]) {
        const result = await executeAction(session, action, snap);
        expect(result.success, JSON.stringify(action)).toBe(false);
        expect(new URL(session.page.url()).origin).toBe(origin);
      }
      expect(externalRequests).toBe(0);
      expect((await executeAction(session, { type: "navigate", url: origin + "/internal" }, snap)).success).toBe(true);
      expect(session.page.url()).toBe(origin + "/landing");
    } finally { await session.close(); await runtime.shutdown(); }
  });

  it("rejects malformed tools and supports posture only through a provided device control", async () => {
    const runtime = new PlaywrightRuntime(); const session = await runtime.launch(BUILTIN_DEVICES["chromium:desktop-1080p"]);
    try {
      await session.page.goto(origin); const snap = await snapshotPage(session.page);
      const bad = await executeAction(session, { type: "tap", x: Number.NaN, y: 1 }, snap);
      expect(bad.success).toBe(false);
      let posture = "";
      session.control.setPosture = async (value) => { posture = value; };
      const result = await executeAction(session, { type: "set_posture", posture: "folded" } as never, snap);
      expect(result?.success).toBe(true); expect(posture).toBe("folded");
    } finally { await session.close(); await runtime.shutdown(); }
  });

  it("honors explicit destructive-action opt-in and a precise additional allowed origin", async () => {
    const runtime = new PlaywrightRuntime(); const session = await runtime.launch(BUILTIN_DEVICES["chromium:desktop-1080p"]);
    try {
      await session.page.goto(origin); const snap = await snapshotPage(session.page);
      const policy = new ActionPolicy(origin, { allowDestructive: true, allowedOrigins: [external] });
      expect((await executeAction(session, { type: "tap", selector: "#danger" }, snap, policy)).success).toBe(true);
      expect(await session.page.locator("body").getAttribute("data-deleted")).toBe("yes");
      expect((await executeAction(session, { type: "navigate", url: external }, snap, policy)).success).toBe(true);
      expect(new URL(session.page.url()).origin).toBe(external);
    } finally { await session.close(); await runtime.shutdown(); }
  });

  it("fails closed on unchecked WebKit redirect chains without contacting the external server", async () => {
    const runtime = new PlaywrightRuntime(); const session = await runtime.launch(BUILTIN_DEVICES["webkit:iphone-se"]);
    try {
      externalRequests = 0; await session.page.goto(origin);
      const result = await executeAction(session, { type: "navigate", url: origin + "/chain" }, await snapshotPage(session.page));
      expect(result.success).toBe(false); expect(result.blocked).toBe(true);
      expect(result.details).toContain("Redirect blocked"); expect(externalRequests).toBe(0);
    } finally { await session.close(); await runtime.shutdown(); }
  });
});

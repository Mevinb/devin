import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import { RunBudget } from "@pixelsentinel/core";
import { CdpCssResolver } from "../src/cdp-css.js";

afterEach(() => vi.restoreAllMocks());
const renderConfig = { name: "Phone", renderId: "phone", width: 390, height: 844, deviceScaleFactor: 1, isMobile: false, hasTouch: false, orientation: "portrait" as const };
it("closes a pending attribution browser without creating a late context", async () => {
  const browser = await chromium.launch(), context = vi.spyOn(browser, "newContext"), closed = vi.spyOn(browser, "close");
  let finish!: (value: typeof browser) => void; const delayed = new Promise<typeof browser>((resolve) => { finish = resolve; });
  vi.spyOn(chromium, "launch").mockReturnValueOnce(delayed);
  const resolver = new CdpCssResolver("http://fixture.invalid", process.cwd(), [process.cwd()]);
  const pending = resolver.resolve("#wide", { renderConfig }), rejected = expect(pending).rejects.toThrow(/shut down/);
  await resolver.close(); finish(browser); await rejected;
  expect(closed).toHaveBeenCalledOnce(); expect(context).not.toHaveBeenCalled();
});

it("aborts a hanging source-map fetch and body on the shared deadline", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-map-deadline-"));
  let mapContacted = false, mapClosed = false;
  const server = createServer((request, response) => {
    if (request.url === "/never.map") { mapContacted = true; response.on("close", () => { mapClosed = true; }); return; }
    if (request.url === "/app.css") { response.setHeader("content-type", "text/css"); response.end("#wide{width:750px}/*# sourceMappingURL=/never.map */"); return; }
    response.setHeader("content-type", "text/html"); response.end('<link rel="stylesheet" href="/app.css"><div id="wide">Overflow</div>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const budget = new RunBudget({ maxMinutes: 0.05 });
  const resolver = new CdpCssResolver(`http://127.0.0.1:${port}/`, temp, [temp], undefined, budget);
  const detach = budget.onAbort(() => resolver.close());
  try {
    expect(await resolver.resolve("#wide", { renderConfig })).toEqual([]);
    expect(mapContacted).toBe(true); expect(budget.snapshot().stopped?.kind).toBe("time");
    await vi.waitFor(() => expect(mapClosed).toBe(true));
  } finally { detach(); budget.dispose(); await resolver.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(temp, { recursive: true, force: true }); }
}, 10000);

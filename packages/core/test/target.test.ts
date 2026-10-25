import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { findServeDirectory } from "../src/target/static-server.js";
import { startDevServer } from "../src/target/dev-server.js";

let temp: string;
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-static-target-")); });
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
it("serves a built frontend before its source entry while preserving explicit HTML-file targets", async () => {
  await fs.mkdir(path.join(temp, "dist"));
  await fs.writeFile(path.join(temp, "index.html"), '<script type="module" src="/src/main.tsx"></script>');
  await fs.writeFile(path.join(temp, "dist/index.html"), "<h1>Built app</h1>");
  await fs.writeFile(path.join(temp, "legacy.html"), "<h1>Explicit static file</h1>");
  expect(findServeDirectory(temp)).toBe(path.join(temp, "dist"));
  expect(findServeDirectory(path.join(temp, "legacy.html"))).toBe(temp);
  expect(() => findServeDirectory(path.join(temp, "index.html"))).toThrow(/build|--start/);
});
it("rejects an unbuilt TypeScript frontend instead of scanning a blank page", async () => {
  await fs.writeFile(path.join(temp, "index.html"), '<script type="module" src="/src/main.tsx"></script>');
  expect(() => findServeDirectory(temp)).toThrow(/build|--start/);
});

it("cancels and terminates an owned dev server while it is still waiting for readiness", async () => {
  await fs.writeFile(path.join(temp, "pending.cjs"), "require('node:fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const pending = startDevServer({ command: "node pending.cjs", port: 0, readyTimeoutMs: 30000 }, temp, controller.signal);
  const rejected = expect(pending).rejects.toThrow();
  let pid = 0;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    pid = Number(await fs.readFile(path.join(temp, "child.pid"), "utf8").catch(() => "0"));
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(pid).toBeGreaterThan(0); controller.abort(new Error("Cancelled before ready")); await rejected;
  let running = true;
  for (let attempt = 0; attempt < 50 && running; attempt++) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 20)); } catch { running = false; }
  }
  expect(running).toBe(false);
});

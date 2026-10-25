import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareOutputDirectory } from "../src/output.js";
import { scan } from "../src/scanner.js";
import { explore } from "../src/explore/run.js";

let temp: string, project: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "ps-output-")); project = path.join(temp, "project");
  await fs.mkdir(project); await fs.writeFile(path.join(project, "index.html"), "<h1>Keep source</h1>");
});
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });

it("rejects source roots, ancestors and symlink aliases before scan/explore launch or deletion", async () => {
  const alias = path.join(temp, "alias"); await fs.symlink(project, alias, "dir");
  for (const run of [scan, explore]) for (const dir of [project, temp, alias, process.cwd()]) {
    await expect(run({ target: project, output: { dir }, vision: { enabled: false } })).rejects.toThrow(/Output directory/);
    expect(await fs.readFile(path.join(project, "index.html"), "utf8")).toBe("<h1>Keep source</h1>");
  }
});

it("refuses an unclaimed source subdirectory and cleans only owned artifact names", async () => {
  const source = path.join(project, "src"); await fs.mkdir(source); await fs.writeFile(path.join(source, "app.ts"), "export {};");
  await expect(prepareOutputDirectory(source, project, true)).rejects.toThrow(/empty or previously generated/);
  expect(await fs.readFile(path.join(source, "app.ts"), "utf8")).toBe("export {};");
  const output = path.join(project, "qa"); await prepareOutputDirectory(output, project, true);
  await fs.mkdir(path.join(output, "renders")); await fs.writeFile(path.join(output, "renders/old.png"), "old");
  await fs.writeFile(path.join(output, "notes.txt"), "Keep review notes");
  await prepareOutputDirectory(output, project, true);
  await expect(fs.access(path.join(output, "renders"))).rejects.toThrow();
  expect(await fs.readFile(path.join(output, "notes.txt"), "utf8")).toBe("Keep review notes");
});

it("adopts legacy reports without erasing unrelated output-directory files", async () => {
  const output = path.join(temp, "legacy"); await fs.mkdir(output);
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ id: "scan-123", config: { target: project }, matrix: [] }));
  await fs.writeFile(path.join(output, "notes.txt"), "Notes");
  await prepareOutputDirectory(output, project, true);
  expect(await fs.readFile(path.join(output, "notes.txt"), "utf8")).toBe("Notes");
  await expect(fs.access(path.join(output, "report.json"))).rejects.toThrow();
  await prepareOutputDirectory(output, project, true);
});

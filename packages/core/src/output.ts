import fs from "node:fs/promises";
import path from "node:path";

const OWNER_FILE = ".pixelsentinel-output.json";
const ARTIFACTS = ["renders", "explore", "patches", "fixes", "report.json", "report.html"];
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve symlinked ancestors even before the output directory exists. */
async function canonical(file: string): Promise<string> {
  try { return await fs.realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonical(parent), path.basename(file));
  }
}

/** Claim an artifact directory; cleanup never recursively removes its root. */
export async function prepareOutputDirectory(outputDir: string, target: string, clean: boolean): Promise<void> {
  const output = await canonical(path.resolve(outputDir));
  const protectedPaths = [await canonical(process.cwd())];
  if (!/^https?:\/\//i.test(target)) protectedPaths.push(await canonical(path.resolve(target)));
  if (protectedPaths.some((file) => contains(output, file)) || path.relative(path.parse(output).root, output).split(path.sep).some((part) => [".git", ".agents", ".codex", ".aws"].includes(part))) {
    throw new Error("Output directory must be separate from the target, working directory, and their ancestors or metadata. Choose an artifact subdirectory with --out.");
  }
  const entries = await fs.readdir(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [] as string[];
  });
  let owned = false;
  try { owned = JSON.parse(await fs.readFile(path.join(output, OWNER_FILE), "utf8")).owner === "pixelsentinel"; } catch { /* Unclaimed or legacy output. */ }
  if (entries.length && !owned) {
    // Recognize reports from versions predating the ownership marker.
    let legacy = false;
    try {
      const report = JSON.parse(await fs.readFile(path.join(output, "report.json"), "utf8"));
      legacy = typeof report.id === "string" && report.id.startsWith("scan-") && typeof report.config?.target === "string" && Array.isArray(report.matrix);
    } catch { /* This is not a previous scanner output. */ }
    if (!legacy) throw new Error("Output directory contains files not identified as PixelSentinel artifacts. Choose an empty or previously generated output directory with --out.");
  }
  await fs.mkdir(output, { recursive: true });
  if (clean) for (const name of ARTIFACTS) await fs.rm(path.join(output, name), { recursive: true, force: true });
  await fs.writeFile(path.join(output, OWNER_FILE), JSON.stringify({ owner: "pixelsentinel", version: 1 }) + "\n");
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { VisionAnalysisResult } from "./types.js";

export class VisionCache {
  private cacheDir: string;

  constructor(cacheDir: string = "./.pixelsentinel/cache") {
    this.cacheDir = cacheDir;
  }

  private computeHash(buffer: Buffer, model: string): string {
    return crypto
      .createHash("sha256")
      .update(buffer)
      .update(model)
      .update("v1")
      .digest("hex");
  }

  async get(buffer: Buffer, model: string): Promise<VisionAnalysisResult | null> {
    try {
      const hash = this.computeHash(buffer, model);
      const filePath = path.join(this.cacheDir, `${hash}.json`);
      const data = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(data) as VisionAnalysisResult;
      parsed.cached = true;
      return parsed;
    } catch {
      return null;
    }
  }

  async set(buffer: Buffer, model: string, result: VisionAnalysisResult): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const hash = this.computeHash(buffer, model);
      const filePath = path.join(this.cacheDir, `${hash}.json`);
      await fs.writeFile(filePath, JSON.stringify(result, null, 2), "utf8");
    } catch {
      // Ignore cache write errors
    }
  }
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { VisionAnalysisResult } from "./types.js";

export class VisionCache {
  private cacheDir: string;

  constructor(cacheDir: string = "./.pixelsentinel/cache") {
    this.cacheDir = cacheDir;
  }

  private computeHash(buffer: Buffer, model: string, contextKey: string): string {
    return crypto
      .createHash("sha256")
      .update(buffer)
      .update(model)
      .update("v2")
      .update(contextKey)
      .digest("hex");
  }

  async get(buffer: Buffer, model: string, contextKey = ""): Promise<VisionAnalysisResult | null> {
    try {
      const hash = this.computeHash(buffer, model, contextKey);
      const filePath = path.join(this.cacheDir, `${hash}.json`);
      const data = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(data) as VisionAnalysisResult;
      parsed.cached = true;
      parsed.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      return parsed;
    } catch {
      return null;
    }
  }

  async set(buffer: Buffer, model: string, result: VisionAnalysisResult, contextKey = ""): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const hash = this.computeHash(buffer, model, contextKey);
      const filePath = path.join(this.cacheDir, `${hash}.json`);
      await fs.writeFile(filePath, JSON.stringify(result, null, 2), "utf8");
    } catch {
      // Ignore cache write errors
    }
  }
}

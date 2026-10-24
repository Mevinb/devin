import type {
  RenderContext,
  VisionAnalysisResult,
  VisionFinding,
  VisionProvider
} from "./types.js";

export class MockVisionProvider implements VisionProvider {
  name = "mock";
  private customFindings: VisionFinding[];

  constructor(customFindings: VisionFinding[] = []) {
    this.customFindings = customFindings;
  }

  setFindings(findings: VisionFinding[]): void {
    this.customFindings = findings;
  }

  async analyze(
    _imageBuffer: Buffer,
    _context: RenderContext
  ): Promise<VisionAnalysisResult> {
    return {
      findings: [...this.customFindings],
      usage: {
        promptTokens: 120,
        completionTokens: 60,
        totalTokens: 180
      },
      cached: false
    };
  }
}

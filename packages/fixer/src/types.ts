import type { AgentAction, RunBudget, ScanConfigInput } from "@pixelsentinel/core";
import type { CssRule } from "./css.js";

export type VerificationStatus = "unverified" | "verified" | "failed" | "diverged";

export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
  confidence: number;
  method: "react-debug" | "css-sourcemap" | "css-cdp" | "grep-fallback";
  cssRule?: CssRule;
  snippet?: string;
  contextLines?: {
    startLine: number;
    lines: string[];
  };
}

export interface PatchProposal {
  id: string;
  findingId: string;
  findingIds?: string[];
  defectType: string;
  file: string;
  startLine: number;
  endLine: number;
  diff: string;
  explanation: string;
  verificationStatus: VerificationStatus;
  verifiedScreenshotPath?: string;
  beforeScreenshotPath?: string;
  verificationMessage?: string;
  verifications?: Array<{
    findingId: string;
    targetId?: string;
    status: VerificationStatus;
    message?: string;
    beforeScreenshotPath?: string;
    afterScreenshotPath?: string;
  }>;
  reproductionTrace?: string[];
  actions?: AgentAction[];
  targetId?: string;
  createdAt: string;
}

export interface FixerConfig {
  repoRoot: string;
  model?: string;
  verifyInWorktree?: boolean;
  scanConfig?: ScanConfigInput;
  liveUrl?: string;
  projectDirs?: string[];
  apiKey?: string;
  budget?: RunBudget;
}

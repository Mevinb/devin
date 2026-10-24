export type VerificationStatus = "unverified" | "verified" | "failed" | "diverged";

export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
  confidence: number;
  method: "react-debug" | "css-sourcemap" | "grep-fallback";
  snippet?: string;
  contextLines?: {
    startLine: number;
    lines: string[];
  };
}

export interface PatchProposal {
  id: string;
  findingId: string;
  defectType: string;
  file: string;
  startLine: number;
  endLine: number;
  diff: string;
  explanation: string;
  verificationStatus: VerificationStatus;
  verifiedScreenshotPath?: string;
  reproductionTrace?: string[];
  targetId?: string;
  createdAt: string;
}

export interface FixerConfig {
  repoRoot: string;
  model?: string;
  verifyInWorktree?: boolean;
}

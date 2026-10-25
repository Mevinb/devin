import type { RenderConfig, ScanConfig } from "../config/schema.js";
import type { Finding } from "../heuristics/types.js";
import type { CaptureMetadata, FailedRequest, KeyboardProbe } from "../capture/types.js";
import type { UsageSnapshot } from "../budget.js";

export interface RenderReportItem {
  renderId: string;
  name: string;
  viewport: RenderConfig;
  status: "pass" | "fail";
  findingsCount: {
    critical: number;
    warning: number;
    info: number;
    total: number;
  };
  screenshotRelPath: string;
  annotatedRelPath: string;
  findings: Finding[];
  consoleErrors: string[];
  failedRequests: FailedRequest[];
  // Phase 2: device runtime + exploration state
  device?: CaptureMetadata["device"];
  deviceScreenshotRelPath?: string;
  keyboardProbes?: KeyboardProbe[];
  pageErrors?: string[];
  warnings?: string[];
  stateId?: string;
  stateName?: string;
  /** Actions that reproduce this state from the start URL. */
  trace?: string[];
}

export interface ScanReportSummary {
  totalViewports: number;
  totalFindings: number;
  criticalFindings: number;
  warningFindings: number;
  infoFindings: number;
  passedViewports: number;
  failedViewports: number;
  defectBreakdown: Record<string, number>;
  durationMs: number;
  fidelityBreakdown?: Record<string, number>;
  statesDiscovered?: number;
  agentCalls?: number;
  agentTokens?: number;
}

export interface ProposedFixReport {
  id: string;
  findingIds: string[];
  file: string;
  verificationStatus: "unverified" | "verified" | "failed" | "diverged";
  diffRelPath: string;
  diff: string;
  explanation: string;
  verificationMessage?: string;
  verifications?: Array<{
    findingId: string;
    targetId?: string;
    status: string;
    message?: string;
    beforeScreenshotRelPath?: string;
    afterScreenshotRelPath?: string;
  }>;
}

export interface ScanReport {
  id: string;
  timestamp: string;
  target: string;
  mode?: "viewports" | "devices" | "explore";
  summary: ScanReportSummary;
  matrix: RenderReportItem[];
  config: ScanConfig;
  warnings?: string[];
  errors?: Array<{ targetId: string; message: string }>;
  fixes?: ProposedFixReport[];
  usage?: UsageSnapshot;
}

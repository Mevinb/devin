import type { RenderConfig, ScanConfig } from "../config/schema.js";
import type { Finding } from "../heuristics/types.js";
import type { FailedRequest } from "../capture/types.js";

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
}

export interface ScanReport {
  id: string;
  timestamp: string;
  target: string;
  summary: ScanReportSummary;
  matrix: RenderReportItem[];
  config: ScanConfig;
}

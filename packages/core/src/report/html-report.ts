import fs from "node:fs/promises";
import path from "node:path";
import type { ScanReport } from "./types.js";
import { REPORT_SCRIPT } from "./report-script.js";

export function generateHtmlReport(report: ScanReport): string {
  const jsonReportString = JSON.stringify(report).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PixelSentinel — Scan Report: ${escapeHtml(report.target)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(22, 30, 49, 0.65);
      --card-border: rgba(255, 255, 255, 0.08);
      --card-hover-border: rgba(99, 102, 241, 0.4);
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --accent: #6366f1;
      --accent-glow: rgba(99, 102, 241, 0.25);
      --critical: #ef4444;
      --critical-bg: rgba(239, 68, 68, 0.15);
      --warning: #f59e0b;
      --warning-bg: rgba(245, 158, 11, 0.15);
      --pass: #10b981;
      --pass-bg: rgba(16, 185, 129, 0.15);
      --info: #3b82f6;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      min-height: 100vh;
      line-height: 1.5;
      background-image: 
        radial-gradient(circle at 15% 10%, rgba(99, 102, 241, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 85% 90%, rgba(239, 68, 68, 0.06) 0%, transparent 45%);
    }

    /* Container */
    .container { max-width: 1440px; margin: 0 auto; padding: 32px 24px; }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 32px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .logo-group { display: flex; align-items: center; gap: 14px; }
    .logo-badge {
      width: 44px; height: 44px;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 20px; color: white;
      box-shadow: 0 8px 24px var(--accent-glow);
    }
    .brand-title { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
    .brand-subtitle { font-size: 13px; color: var(--text-muted); }
    .target-url {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      background: rgba(255, 255, 255, 0.04);
      padding: 6px 14px;
      border-radius: 8px;
      border: 1px solid var(--card-border);
      color: #cbd5e1;
      max-width: 450px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Summary Grid */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .summary-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 20px;
      position: relative;
      overflow: hidden;
    }
    .summary-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
    }
    .card-total::before { background: var(--accent); }
    .card-critical::before { background: var(--critical); }
    .card-warning::before { background: var(--warning); }
    .card-passed::before { background: var(--pass); }

    .summary-label { font-size: 13px; color: var(--text-muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-value { font-size: 32px; font-weight: 800; margin-top: 6px; letter-spacing: -1px; }

    /* Filters Bar */
    .filter-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px 18px;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .filter-tabs { display: flex; gap: 8px; }
    .filter-tab {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .filter-tab:hover { color: var(--text); background: rgba(255, 255, 255, 0.04); }
    .filter-tab.active {
      color: white;
      background: var(--accent);
      box-shadow: 0 4px 12px var(--accent-glow);
    }

    /* Matrix Cards Grid */
    .matrix-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 20px;
    }
    .render-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      overflow: hidden;
      cursor: pointer;
      transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .render-card:hover {
      transform: translateY(-3px);
      border-color: var(--card-hover-border);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
    }

    .render-thumb-wrapper {
      height: 200px;
      background: #04070e;
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .render-thumb {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .thumb-badge {
      position: absolute;
      top: 12px;
      right: 12px;
      font-size: 12px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 20px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .fidelity-badge {
      position: absolute;
      top: 12px;
      left: 12px;
      font-size: 10px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .fidelity-real { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.4); }
    .fidelity-webview { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(96, 165, 250, 0.4); }
    .fidelity-approx { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.4); }

    .badge-pass { background: var(--pass-bg); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); }
    .badge-fail { background: var(--critical-bg); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.3); }

    .render-info { padding: 18px; }
    .render-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
    .render-specs { font-size: 12px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; margin-bottom: 12px; }
    .render-pills { display: flex; gap: 8px; flex-wrap: wrap; }
    .pill {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 6px;
    }
    .pill-critical { background: var(--critical-bg); color: #fca5a5; }
    .pill-warning { background: var(--warning-bg); color: #fcd34d; }
    .pill-pass { background: var(--pass-bg); color: #6ee7b7; }

    /* Modal / Inspector */
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(4, 7, 14, 0.85);
      backdrop-filter: blur(8px);
      z-index: 1000;
      padding: 24px;
      align-items: center;
      justify-content: center;
    }
    .modal-backdrop.open { display: flex; }
    .modal-container {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 18px;
      width: 95vw;
      height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    }
    .modal-header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-body {
      display: grid;
      grid-template-columns: 1fr 440px;
      flex: 1;
      overflow: hidden;
    }
    .viewer-pane {
      background: #020617;
      overflow: auto;
      padding: 24px;
      display: flex;
      align-items: flex-start;
      justify-content: center;
    }
    .viewer-image {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.5);
    }
    .sidebar-pane {
      border-left: 1px solid var(--card-border);
      overflow-y: auto;
      padding: 20px;
      background: rgba(15, 23, 42, 0.95);
    }
    .finding-card {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 14px;
    }
    .finding-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .finding-num {
      width: 22px; height: 22px; border-radius: 6px; background: var(--accent);
      color: white; font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center;
    }
    .finding-desc { font-size: 13px; line-height: 1.5; margin-bottom: 10px; color: #e2e8f0; }
    .selector-box {
      background: #090d16;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px;
      padding: 8px 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #93c5fd;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
    }
    .selector-box:hover { border-color: var(--accent); }
    .trace-box {
      background: rgba(0,0,0,0.3);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 11px;
      color: #cbd5e1;
      margin-top: 8px;
    }
    .close-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 24px;
      cursor: pointer;
    }
    .close-btn:hover { color: white; }
    .render-card { text-align: left; font: inherit; color: var(--text); }
    .state-name { color: #b8baff; font-weight: 600; margin-top: 5px; }
    .report-muted { color: var(--text-muted); font-size: 12px; margin: 8px 0; overflow-wrap: anywhere; }
    .report-notice { padding: 12px; border: 1px solid #806431; color: #fde68a; border-radius: 7px; margin: 12px 0; font-size: 13px; overflow-wrap: anywhere; }
    .report-error { border-color: #803a45; color: #fecaca; }
    .usage-panel { margin: 24px 0; padding: 18px; border: 1px solid var(--card-border); border-radius: 10px; min-width: 0; }
    .usage-table-wrap { overflow-x: auto; margin: 12px 0; }
    .usage-panel table { border-collapse: collapse; width: 100%; text-align: left; font-size: 13px; }
    .usage-panel th, .usage-panel td { padding: 10px; border-bottom: 1px solid var(--card-border); white-space: nowrap; }
    .image-tabs { display: flex; gap: 10px; padding: 10px 20px; border-bottom: 1px solid var(--card-border); }
    .selector-box { width: 100%; margin: 8px 0; text-align: left; overflow-wrap: anywhere; }
    .patch-detail { margin: 20px 0; padding: 16px; border: 1px solid var(--card-border); border-radius: 8px; font-size: 13px; }
    .patch-detail summary, .verification-evidence summary { cursor: pointer; font-weight: 600; padding: 6px 0; overflow-wrap: anywhere; }
    .patch-detail p { margin: 8px 0; }
    .patch-detail a { color: #a5b4fc; }
    .patch-code { background: #060911; border: 1px solid var(--card-border); border-radius: 5px; padding: 12px; overflow: auto; margin: 12px 0; font: 12px/1.6 monospace; white-space: pre; }
    .apply-command { display: block; overflow-wrap: anywhere; margin: 12px 0; }
    .verification-evidence { margin: 12px 0; }
    .evidence-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .evidence-pair figure { min-width: 0; }
    .evidence-pair img { max-width: 100%; max-height: 280px; object-fit: contain; }
    .trace-box ol { margin-left: 16px; overflow-wrap: anywhere; }
    #fixesPanel { margin-top: 28px; }
    button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 3px; }
    @media (max-width: 800px) {
      .container { padding: 20px 12px; }
      .filter-bar, .filter-tabs { flex-wrap: wrap; gap: 10px; }
      .matrix-grid { grid-template-columns: minmax(0, 1fr); }
      .modal-backdrop { padding: 8px; }
      .modal-container { width: 100%; max-height: 95vh; height: 95vh; }
      .modal-body { display: flex; flex-direction: column; overflow-y: auto; }
      .viewer-pane { max-height: 40vh; min-height: 200px; flex-shrink: 0; }
      .sidebar-pane { overflow-y: visible; }
      .evidence-pair { grid-template-columns: 1fr; }
      .modal-header h2 { overflow-wrap: anywhere; }
    }

  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-group">
        <div class="logo-badge">PS</div>
        <div>
          <h1 class="brand-title">PixelSentinel</h1>
          <p class="brand-subtitle">Visual QA Platform — Real Devices & Exploration Matrix</p>
        </div>
      </div>
      <div class="target-url" title="${escapeHtml(report.target)}">🎯 ${escapeHtml(report.target)}</div>
    </header>

    <!-- Metrics -->
    <div class="summary-grid">
      <div class="summary-card card-total">
        <div class="summary-label">Targets Tested</div>
        <div class="summary-value">${report.summary.totalViewports}</div>
      </div>
      <div class="summary-card card-critical">
        <div class="summary-label">Critical Defects</div>
        <div class="summary-value" style="color: #ef4444">${report.summary.criticalFindings}</div>
      </div>
      <div class="summary-card card-warning">
        <div class="summary-label">Warnings</div>
        <div class="summary-value" style="color: #f59e0b">${report.summary.warningFindings}</div>
      </div>
      <div class="summary-card card-passed">
        <div class="summary-label">Pass Rate</div>
        <div class="summary-value" style="color: #10b981">${
          report.summary.totalViewports > 0
            ? Math.round((report.summary.passedViewports / report.summary.totalViewports) * 100)
            : 100
        }%</div>
      </div>
    </div>

    <div id="reportWarnings"></div>
    <section id="usagePanel" class="usage-panel" aria-label="AI usage and budget" hidden></section>

    <!-- Filters -->
    <div class="filter-bar">
      <div class="filter-tabs" id="filterTabs">
        <button class="filter-tab active" data-filter="all">All Targets (${report.matrix.length})</button>
        <button class="filter-tab" data-filter="failed">Defects Only (${report.summary.failedViewports})</button>
        <button class="filter-tab" data-filter="passed">Clean Only (${report.summary.passedViewports})</button>
      </div>
    </div>

    <!-- Matrix Grid -->
    <div class="matrix-grid" id="matrixGrid"></div>
    <section id="fixesPanel"></section>
  </div>

  <!-- Inspector Modal -->
  <div class="modal-backdrop" id="inspectorModal">
    <div class="modal-container" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div class="modal-header">
        <div>
          <h2 id="modalTitle" style="font-size: 18px; font-weight: 700;">Target Inspector</h2>
          <span id="modalSubtitle" style="font-size: 12px; color: var(--text-muted); font-family: monospace;"></span>
        </div>
        <button class="close-btn" id="closeModal" aria-label="Close inspector">&times;</button>
      </div>
      <div id="imageTabs" class="image-tabs"></div>
      <div class="modal-body">
        <div class="viewer-pane">
          <img id="viewerImg" class="viewer-image" src="" alt="Annotated Viewport" />
        </div>
        <div class="sidebar-pane" id="findingsSidebar"></div>
      </div>
    </div>
  </div>

  <script id="report-data" type="application/json">${jsonReportString}</script>
  <script>${REPORT_SCRIPT}
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function writeHtmlReport(
  report: ScanReport,
  outputDir: string
): Promise<string> {
  const htmlContent = generateHtmlReport(report);
  const reportPath = path.join(outputDir, "report.html");
  await fs.writeFile(reportPath, htmlContent, "utf8");
  return reportPath;
}

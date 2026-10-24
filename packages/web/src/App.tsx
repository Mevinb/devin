import React, { useState, useEffect } from "react";
import {
  Monitor,
  Tablet,
  Smartphone,
  Tv,
  Bug,
  CheckCircle2,
  AlertTriangle,
  Play,
  Sparkles,
  Copy,
  X,
  ExternalLink,
  RefreshCw,
  Eye,
  Compass,
  Wrench,
  Check
} from "lucide-react";

interface Finding {
  id: string;
  type: string;
  severity: "critical" | "warning" | "info";
  confidence: number;
  sources: string[];
  description: string;
  suggestedFix?: string;
  proposedFixId?: string;
  stateId?: string;
  device?: string;
  fidelity?: "real" | "webview" | "approximate";
  elements: Array<{
    selector: string;
    tagName?: string;
    text?: string;
  }>;
}

interface RenderItem {
  renderId: string;
  name: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    orientation: string;
    isMobile: boolean;
    fidelity?: "real" | "webview" | "approximate";
  };
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
}

interface ScanReport {
  id: string;
  timestamp: string;
  target: string;
  summary: {
    totalViewports: number;
    totalFindings: number;
    criticalFindings: number;
    warningFindings: number;
    passedViewports: number;
    failedViewports: number;
    durationMs: number;
  };
  matrix: RenderItem[];
}

interface ScanJob {
  id: string;
  target: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: {
    step: string;
    completed: number;
    total: number;
    detail?: string;
  };
  report?: ScanReport;
  error?: string;
}

export function App() {
  const [target, setTarget] = useState("http://localhost:5173");
  const [enableVision, setEnableVision] = useState(true);
  const [enableExplore, setEnableExplore] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ScanJob | null>(null);
  const [currentReport, setCurrentReport] = useState<ScanReport | null>(null);
  const [selectedItem, setSelectedItem] = useState<RenderItem | null>(null);
  const [activeDiffFinding, setActiveDiffFinding] = useState<Finding | null>(null);
  const [filter, setFilter] = useState<"all" | "failed" | "passed">("all");
  const [copiedSelector, setCopiedSelector] = useState<string | null>(null);

  // Poll active scan job status
  useEffect(() => {
    if (!activeJobId) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/scans/${activeJobId}`);
        if (!res.ok) return;
        const job: ScanJob = await res.json();
        setActiveJob(job);

        if (job.status === "completed" && job.report) {
          setCurrentReport(job.report);
          setActiveJobId(null);
        } else if (job.status === "failed") {
          setActiveJobId(null);
        }
      } catch {
        // Ignore network polling glitches
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [activeJobId]);

  const handleStartScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;

    try {
      const res = await fetch("/api/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          explore: enableExplore,
          vision: { enabled: enableVision }
        })
      });

      if (!res.ok) {
        alert("Failed to start scan");
        return;
      }

      const data = await res.json();
      setActiveJobId(data.jobId);
      setActiveJob({
        id: data.jobId,
        target,
        status: "queued",
        progress: {
          step: "queued",
          completed: 0,
          total: 1,
          detail: enableExplore
            ? "Launching autonomous exploration agent..."
            : "Initializing scanner..."
        }
      });
    } catch (err) {
      alert("Error starting scan: " + String(err));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSelector(text);
    setTimeout(() => setCopiedSelector(null), 2000);
  };

  const getDeviceIcon = (item: RenderItem) => {
    const nameLower = item.name.toLowerCase();
    if (nameLower.includes("tv")) {
      return <Tv size={16} color="#ec4899" />;
    }
    if (item.viewport.isMobile) {
      return item.viewport.width > 600 ? (
        <Tablet size={16} color="#a855f7" />
      ) : (
        <Smartphone size={16} color="#6366f1" />
      );
    }
    return <Monitor size={16} color="#38bdf8" />;
  };

  const filteredMatrix = (currentReport?.matrix || []).filter((item) => {
    if (filter === "failed") return item.status === "fail";
    if (filter === "passed") return item.status === "pass";
    return true;
  });

  return (
    <div className="app-container">
      {/* Navigation */}
      <header className="navbar">
        <div className="brand">
          <div className="brand-icon">PS</div>
          <div>
            <h1 className="brand-name">PixelSentinel</h1>
            <p className="brand-tagline">Real Devices • Autonomous Exploration • Fix Proposals</p>
          </div>
        </div>
        <div className="nav-actions">
          <div className="status-badge">
            <span className="pulse-dot"></span>
            Fleet Engine Ready
          </div>
        </div>
      </header>

      {/* Scan Launcher Form */}
      <section className="glass-card launcher-panel">
        <div className="launcher-header">
          <h2 className="launcher-title">New Multi-Device & State Scan</h2>
          <p className="launcher-desc">
            Test responsive web apps across physical Android emulators, WebKit iOS approximations, and explore dynamic UI states automatically.
          </p>
        </div>

        <form onSubmit={handleStartScan}>
          <div className="input-row">
            <input
              type="text"
              className="target-input"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="e.g. https://example.com or ./my-app/dist"
              required
            />
            <button
              type="submit"
              className="primary-btn"
              disabled={Boolean(activeJobId)}
            >
              {activeJobId ? (
                <>
                  <RefreshCw size={18} className="spin-icon" />
                  Scanning Fleet...
                </>
              ) : (
                <>
                  <Play size={18} fill="currentColor" />
                  Run Fleet Scan
                </>
              )}
            </button>
          </div>

          <div className="options-row">
            <div className="matrix-presets">
              <span style={{ fontSize: "12px", color: "var(--text-dim)", marginRight: "4px" }}>
                Fleet:
              </span>
              <button type="button" className="preset-chip active">
                Android + iOS + Desktop
              </button>
            </div>

            <div className="toggles-group" style={{ display: "flex", gap: "16px" }}>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  className="toggle-checkbox"
                  checked={enableExplore}
                  onChange={(e) => setEnableExplore(e.target.checked)}
                />
                <Compass size={16} color="#38bdf8" />
                <span>Autonomous Agent Exploration</span>
              </label>

              <label className="toggle-label">
                <input
                  type="checkbox"
                  className="toggle-checkbox"
                  checked={enableVision}
                  onChange={(e) => setEnableVision(e.target.checked)}
                />
                <Sparkles size={16} color="#a855f7" />
                <span>OpenAI Vision AI</span>
              </label>
            </div>
          </div>
        </form>
      </section>

      {/* Real-time Progress Bar */}
      {activeJob && activeJob.status !== "completed" && (
        <section className="glass-card progress-card">
          <div className="progress-header">
            <div className="progress-title">
              <RefreshCw size={16} color="#6366f1" className="spin-icon" />
              Running Scan on {activeJob.target}
            </div>
            <span style={{ fontSize: "12px", color: "#94a3b8" }}>
              {activeJob.progress.completed} / {activeJob.progress.total}
            </span>
          </div>
          <div className="progress-track">
            <div
              className="progress-bar"
              style={{
                width: `${
                  activeJob.progress.total > 0
                    ? Math.round((activeJob.progress.completed / activeJob.progress.total) * 100)
                    : 15
                }%`
              }}
            ></div>
          </div>
          <div className="progress-detail">{activeJob.progress.detail || "Running tests..."}</div>
        </section>
      )}

      {/* Scan Results */}
      {currentReport && (
        <section>
          {/* KPI Cards */}
          <div className="kpi-grid">
            <div className="glass-card kpi-card kpi-total">
              <div className="kpi-label">Targets / States</div>
              <div className="kpi-value">{currentReport.summary.totalViewports}</div>
            </div>
            <div className="glass-card kpi-card kpi-critical">
              <div className="kpi-label">Critical Defects</div>
              <div className="kpi-value" style={{ color: "#ef4444" }}>
                {currentReport.summary.criticalFindings}
              </div>
            </div>
            <div className="glass-card kpi-card kpi-warning">
              <div className="kpi-label">Visual Warnings</div>
              <div className="kpi-value" style={{ color: "#f59e0b" }}>
                {currentReport.summary.warningFindings}
              </div>
            </div>
            <div className="glass-card kpi-card kpi-pass">
              <div className="kpi-label">Clean Pass Rate</div>
              <div className="kpi-value" style={{ color: "#10b981" }}>
                {currentReport.summary.totalViewports > 0
                  ? Math.round(
                      (currentReport.summary.passedViewports /
                        currentReport.summary.totalViewports) *
                        100
                    )
                  : 100}
                %
              </div>
            </div>
          </div>

          {/* Matrix Header & Filter */}
          <div className="matrix-section-header">
            <div>
              <h2 style={{ fontSize: "20px", fontWeight: 800 }}>Device × State Results</h2>
              <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                Click any device state to view layout bounding boxes, safe-area collisions, and self-verifying fixes.
              </p>
            </div>
            <div className="matrix-presets">
              <button
                className={`preset-chip ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                All ({currentReport.matrix.length})
              </button>
              <button
                className={`preset-chip ${filter === "failed" ? "active" : ""}`}
                onClick={() => setFilter("failed")}
              >
                Defects ({currentReport.summary.failedViewports})
              </button>
              <button
                className={`preset-chip ${filter === "passed" ? "active" : ""}`}
                onClick={() => setFilter("passed")}
              >
                Clean ({currentReport.summary.passedViewports})
              </button>
            </div>
          </div>

          {/* Matrix Grid */}
          <div className="matrix-grid">
            {filteredMatrix.map((item) => {
              const fidelity = item.viewport.fidelity || "approximate";
              const fidColor =
                fidelity === "real" ? "#10b981" : fidelity === "webview" ? "#3b82f6" : "#f59e0b";

              return (
                <div
                  key={item.renderId}
                  className="device-card"
                  onClick={() => setSelectedItem(item)}
                >
                  <div className="device-preview">
                    <img
                      src={`/artifacts/${item.annotatedRelPath}`}
                      alt={item.name}
                      className="device-img"
                      loading="lazy"
                    />
                    <div
                      style={{
                        position: "absolute",
                        top: "10px",
                        left: "10px",
                        fontSize: "10px",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        background: "rgba(15, 23, 42, 0.8)",
                        border: `1px solid ${fidColor}`,
                        color: fidColor,
                        padding: "2px 8px",
                        borderRadius: "4px"
                      }}
                    >
                      {fidelity}
                    </div>

                    <div
                      className={`status-ribbon ${
                        item.status === "pass" ? "ribbon-pass" : "ribbon-fail"
                      }`}
                    >
                      {item.status === "pass" ? (
                        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                          <CheckCircle2 size={12} /> Clean
                        </span>
                      ) : (
                        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                          <Bug size={12} /> {item.findings.length} Defects
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="device-details">
                    <div className="device-name-row">
                      <span className="device-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {getDeviceIcon(item)}
                        {item.name}
                      </span>
                    </div>
                    <div className="device-meta">
                      {item.viewport.width}×{item.viewport.height} @{item.viewport.deviceScaleFactor}x •{" "}
                      {item.viewport.orientation}
                    </div>
                    <div className="badge-row">
                      {item.findingsCount.critical > 0 && (
                        <span
                          className="pill-badge"
                          style={{ background: "rgba(239, 68, 68, 0.15)", color: "#fca5a5" }}
                        >
                          {item.findingsCount.critical} Critical
                        </span>
                      )}
                      {item.findingsCount.warning > 0 && (
                        <span
                          className="pill-badge"
                          style={{ background: "rgba(245, 158, 11, 0.15)", color: "#fcd34d" }}
                        >
                          {item.findingsCount.warning} Warning
                        </span>
                      )}
                      {item.status === "pass" && (
                        <span
                          className="pill-badge"
                          style={{ background: "rgba(16, 185, 129, 0.15)", color: "#6ee7b7" }}
                        >
                          Clean
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Inspector Modal */}
      {selectedItem && (
        <div className="modal-overlay" onClick={() => setSelectedItem(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-nav">
              <div>
                <h3 style={{ fontSize: "17px", fontWeight: 700 }}>{selectedItem.name}</h3>
                <span
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)"
                  }}
                >
                  {selectedItem.viewport.width}×{selectedItem.viewport.height} @
                  {selectedItem.viewport.deviceScaleFactor}x ({selectedItem.viewport.orientation})
                </span>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <a
                  href={`/artifacts/${selectedItem.annotatedRelPath}`}
                  target="_blank"
                  rel="noreferrer"
                  className="icon-btn"
                  title="Open full image in new tab"
                >
                  <ExternalLink size={18} />
                </a>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setSelectedItem(null)}
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="modal-split">
              {/* Screenshot View */}
              <div className="screenshot-view">
                <img
                  src={`/artifacts/${selectedItem.annotatedRelPath}`}
                  alt={selectedItem.name}
                  className="screenshot-img"
                />
              </div>

              {/* Finding Details Sidebar */}
              <div className="inspector-panel">
                <h4 style={{ fontSize: "15px", fontWeight: 700, marginBottom: "16px" }}>
                  Detected Defects ({selectedItem.findings.length})
                </h4>

                {selectedItem.findings.length === 0 ? (
                  <div
                    style={{
                      background: "rgba(16, 185, 129, 0.1)",
                      border: "1px solid rgba(16, 185, 129, 0.2)",
                      borderRadius: "12px",
                      padding: "16px",
                      color: "#34d399",
                      fontSize: "13px",
                      display: "flex",
                      alignItems: "center",
                      gap: "10px"
                    }}
                  >
                    <CheckCircle2 size={18} />
                    All responsive visual checks passed cleanly for this target!
                  </div>
                ) : (
                  selectedItem.findings.map((f, idx) => {
                    const isCrit = f.severity === "critical";
                    const isWarn = f.severity === "warning";
                    const sevColor = isCrit ? "#ef4444" : isWarn ? "#f59e0b" : "#38bdf8";

                    return (
                      <div key={f.id || idx} className="defect-item">
                        <div className="defect-top">
                          <div className="defect-badge">
                            <span className="num-tag" style={{ background: sevColor }}>
                              {idx + 1}
                            </span>
                            <span className="defect-type-tag" style={{ color: sevColor }}>
                              {f.type}
                            </span>
                          </div>
                          <div style={{ display: "flex", gap: "4px" }}>
                            {f.sources.map((s) => (
                              <span key={s} className="source-tag">
                                {s}
                              </span>
                            ))}
                          </div>
                        </div>

                        <p className="defect-desc">{f.description}</p>

                        {f.suggestedFix && (
                          <div className="fix-tip">
                            <strong>Fix Hint:</strong> {f.suggestedFix}
                          </div>
                        )}

                        <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                          <button
                            type="button"
                            className="preset-chip"
                            style={{
                              background: "rgba(99, 102, 241, 0.15)",
                              color: "#a5b4fc",
                              border: "1px solid rgba(99, 102, 241, 0.3)",
                              display: "flex",
                              alignItems: "center",
                              gap: "6px"
                            }}
                            onClick={() => setActiveDiffFinding(f)}
                          >
                            <Wrench size={13} /> Proposed Diff
                          </button>
                        </div>

                        {f.elements && f.elements.length > 0 && (
                          <div style={{ marginTop: "10px" }}>
                            {f.elements.map((el, elIdx) => (
                              <button
                                key={elIdx}
                                type="button"
                                className="dom-selector-btn"
                                onClick={() => copyToClipboard(el.selector)}
                                title="Click to copy CSS selector"
                              >
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {el.selector}
                                </span>
                                <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                  <Copy size={12} />
                                  {copiedSelector === el.selector ? "COPIED!" : "COPY"}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Proposed Fix Diff Viewer Modal */}
      {activeDiffFinding && (
        <div className="modal-overlay" onClick={() => setActiveDiffFinding(null)}>
          <div
            className="modal-content"
            style={{ maxWidth: "700px", height: "auto", maxHeight: "80vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-nav">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Wrench size={18} color="#6366f1" />
                <h3 style={{ fontSize: "16px", fontWeight: 700 }}>
                  Proposed Fix: {activeDiffFinding.type}
                </h3>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setActiveDiffFinding(null)}
              >
                <X size={20} />
              </button>
            </div>
            <div style={{ padding: "20px", overflowY: "auto" }}>
              <p style={{ fontSize: "13px", color: "#cbd5e1", marginBottom: "14px" }}>
                {activeDiffFinding.suggestedFix || "Verified unified patch to resolve layout collision."}
              </p>
              <div
                style={{
                  background: "#020617",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: "8px",
                  padding: "14px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "12px",
                  lineHeight: "1.6",
                  color: "#94a3b8"
                }}
              >
                <div style={{ color: "#64748b" }}># Git Unified Diff Proposal:</div>
                <div style={{ color: "#ef4444" }}>- width: 100vw;</div>
                <div style={{ color: "#10b981" }}>+ max-width: 100%;</div>
                <div style={{ color: "#10b981" }}>+ overflow-x: hidden;</div>
                <div style={{ color: "#10b981" }}>+ padding-top: max(16px, env(safe-area-inset-top));</div>
              </div>
              <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => {
                    copyToClipboard("git apply pixelsentinel-output/fixes/patch.diff");
                    alert("Copied git apply command to clipboard!");
                  }}
                >
                  <Copy size={16} /> Copy git apply Command
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

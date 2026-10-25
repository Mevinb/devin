import { useEffect, useState } from "react";
import { AlertTriangle, Bug, CheckCircle2, Compass, Monitor, Play, RefreshCw, Smartphone, Sparkles, Tablet, Tv, Wrench } from "lucide-react";
import type { DeviceTarget, ExploreProgressEvent, ProposedFixReport, RenderReportItem } from "@pixelsentinel/core";
import { artifactUrl, fetchJson, useScanJob, type ScanJob } from "./api";
import { PatchViewer, ReportInspector } from "./ReportView";
import { UsageMeter } from "./UsageMeter";

const DESKTOP = "chromium:desktop-1080p";
const FLEET = "chromium:desktop-1080p,android:pixel-8,webkit:iphone-15-pro";
function DeviceIcon({ item }: { item: RenderReportItem }) {
  if (item.name.toLowerCase().includes("tv")) return <Tv size={16}/>;
  return item.viewport.isMobile ? item.viewport.width > 600 ? <Tablet size={16}/> : <Smartphone size={16}/> : <Monitor size={16}/>;
}

export function App() {
  const [target, setTarget] = useState("http://localhost:5173");
  const [deviceIds, setDeviceIds] = useState(DESKTOP);
  const [catalog, setCatalog] = useState<DeviceTarget[]>([]);
  const [enableVision, setEnableVision] = useState(false);
  const [enableExplore, setEnableExplore] = useState(false);
  const [enableFixes, setEnableFixes] = useState(false);
  const [mockAgent, setMockAgent] = useState(true);
  const [maxSteps, setMaxSteps] = useState(15);
  const [maxStates, setMaxStates] = useState(20);
  const [maxMinutes, setMaxMinutes] = useState(5);
  const [maxActions, setMaxActions] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [maxCost, setMaxCost] = useState("");
  const [model, setModel] = useState("gpt-4o");
  const [modelCeiling, setModelCeiling] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [reportJob, setReportJob] = useState<ScanJob | null>(null);
  const [history, setHistory] = useState<ScanJob[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<RenderReportItem | null>(null);
  const [activePatch, setActivePatch] = useState<ProposedFixReport | null>(null);
  const [deviceFrame, setDeviceFrame] = useState(false);
  const [filter, setFilter] = useState<"all" | "failed" | "passed">("all");
  const [copied, setCopied] = useState<string | null>(null);
  const { job, connectionError, missingJobId } = useScanJob(activeJobId);
  const currentReport = reportJob?.report;
  const artifactBase = reportJob?.artifactBaseUrl ?? "/artifacts/";
  const isLocal = !/^https?:\/\//i.test(target);
  const busy = submitting || activeJobId !== null;

  useEffect(() => {
    if (missingJobId && missingJobId === activeJobId) {
      setActiveJobId(null);
      setError("That scan is no longer available. The server may have restarted. Run the scan again.");
    }
  }, [missingJobId, activeJobId]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      fetchJson<ScanJob[]>("/api/scans", { signal: controller.signal }).then((jobs) => {
        setHistory(jobs);
        const running = jobs.find((item) => item.status === "running" || item.status === "queued");
        if (running) setActiveJobId((id) => id ?? running.id);
      }),
      fetchJson<{ devices: DeviceTarget[] }>("/api/devices", { signal: controller.signal }).then((data) => setCatalog(data.devices))
    ]);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!job || job.id !== activeJobId || (job.status !== "completed" && job.status !== "failed")) return;
    setHistory((previous) => [job, ...previous.filter((item) => item.id !== job.id)]);
    if (job.report) { setReportJob(job); setFilter("all"); }
    if (job.error) setError(job.error);
    setActiveJobId(null);
  }, [job, activeJobId]);

  useEffect(() => {
    if (!selectedItem && !activePatch) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (activePatch) setActivePatch(null); else setSelectedItem(null); }
    };
    window.addEventListener("keydown", close);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", close); };
  }, [selectedItem, activePatch]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); }
    catch { setError("Clipboard access failed. Select and copy the visible text."); }
  };
  const startScan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if ((inputPrice === "") !== (outputPrice === "")) { setError("Provide both input and output model prices."); return; }
    if (inputPrice !== "" && modelCeiling === "") { setError("Provide the model input token ceiling with its prices."); return; }
    if (enableExplore && !deviceIds.trim()) { setError("Select at least one device runtime for exploration."); return; }
    setSubmitting(true); setError(null); setSelectedItem(null); setActivePatch(null); setReportJob(null);
    try {
      const result = await fetchJson<{ jobId: string }>("/api/scans", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          target: target.trim(), ...(deviceIds.trim() ? { devices: deviceIds.split(",").map((id) => id.trim()).filter(Boolean) } : { devices: [] }),
          explore: enableExplore, exploreConfig: { maxSteps, maxStates, maxMinutes, model, useMockAgent: mockAgent },
          vision: { enabled: enableVision, model }, proposeFixes: isLocal && enableFixes, concurrency: 1,
          budget: { maxMinutes, ...(maxActions !== "" ? { maxActions: Number(maxActions) } : {}), ...(maxTokens !== "" ? { maxTokens: Number(maxTokens) } : {}),
            ...(maxCost !== "" ? { maxCostUsd: Number(maxCost) } : {}), ...(modelCeiling !== "" ? { models: { [model]: { contextTokens: Number(modelCeiling),
              ...(inputPrice !== "" && outputPrice !== "" ? { inputUsdPerMillion: Number(inputPrice), outputUsdPerMillion: Number(outputPrice) } : {}) } } } : {}) },
          ...(isLocal && startCommand.trim() ? { devServer: { command: startCommand.trim(), port: 0 } } : {})
        })
      });
      setActiveJobId(result.jobId);
    } catch (failure) { setError((failure as Error).message); }
    finally { setSubmitting(false); }
  };
  const inspect = (item: RenderReportItem) => { setDeviceFrame(false); setSelectedItem(item); };
  const showJob = (selected: ScanJob) => {
    if (selected.report) { setReportJob(selected); setFilter("all"); setSelectedItem(null); setActivePatch(null); }
    else if (selected.status === "running" || selected.status === "queued") setActiveJobId(selected.id);
    else setError(selected.error ?? "This job has no report");
  };
  const filtered = (currentReport?.matrix ?? []).filter((item) => filter === "all" || item.status === (filter === "failed" ? "fail" : "pass"));
  const live = job?.id === activeJobId ? job : null;
  const observed = live ?? reportJob;
  const agentEvents = (observed?.events ?? []).filter((event) => event.type === "agent");
  const latestShot = [...agentEvents].reverse().map((event) => event.data as ExploreProgressEvent).find((event) => event.action && event.screenshotPath)?.screenshotPath;

  return <div className="app-container">
    <header className="navbar"><div className="brand"><div className="brand-icon">PS</div><div>
      <h1 className="brand-name">PixelSentinel</h1><p className="brand-tagline">Device testing · Application states · Source fixes</p></div></div>
      <div className="status-badge"><span className={busy ? "pulse-dot" : "idle-dot"}/>{busy ? "Scan in progress" : "Ready to scan"}</div></header>

    <section className="glass-card launcher-panel"><div className="launcher-header"><h2 className="launcher-title">New device and state scan</h2>
      <p className="launcher-desc">Choose browser viewports or device runtimes, explore application states, and review proposed fixes.</p></div>
      <form onSubmit={startScan}>
        <div className="input-row"><input type="text" className="target-input" aria-label="Scan target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="URL or local project path" required/>
          <button className="primary-btn" type="submit" disabled={busy}>{busy ? <RefreshCw size={18} className="spin-icon"/> : <Play size={18}/>} {busy ? "Scanning…" : "Run scan"}</button></div>
        <div className="options-row"><div className="matrix-presets"><span className="muted">Devices:</span>
          <button type="button" disabled={enableExplore} className={`preset-chip ${deviceIds === "" ? "active" : ""}`} onClick={() => setDeviceIds("")}>Responsive viewports</button>
          <button type="button" className={`preset-chip ${deviceIds === DESKTOP ? "active" : ""}`} onClick={() => setDeviceIds(DESKTOP)}>Desktop</button>
          <button type="button" className={`preset-chip ${deviceIds === FLEET ? "active" : ""}`} onClick={() => setDeviceIds(FLEET)}>Phone + iOS + desktop</button></div></div>
        <label className="field-label">Device IDs <input className="target-input compact-input" aria-label="Device IDs" value={deviceIds} onChange={(event) => setDeviceIds(event.target.value)} placeholder="Leave empty for the viewport matrix"/></label>
        {catalog.length > 0 && <details className="profile-picker"><summary>Choose device profiles</summary><div className="profile-grid">
          {catalog.map((device) => <label key={device.id}><input type="checkbox" checked={deviceIds.split(",").map((id) => id.trim()).includes(device.id)} onChange={(event) => {
            const ids = new Set(deviceIds.split(",").map((id) => id.trim()).filter(Boolean));
            if (event.target.checked) ids.add(device.id); else ids.delete(device.id); setDeviceIds([...ids].join(","));
          }}/>{device.name}</label>)}</div></details>}
        <div className="options-row toggles-group"><label className="toggle-label"><input type="checkbox" className="toggle-checkbox" checked={enableExplore} onChange={(event) => { setEnableExplore(event.target.checked); if (event.target.checked && !deviceIds.trim()) setDeviceIds(FLEET); }}/><Compass size={16}/><span>Explore application states</span></label>
          <label className="toggle-label"><input type="checkbox" className="toggle-checkbox" checked={enableVision} onChange={(event) => setEnableVision(event.target.checked)}/><Sparkles size={16}/><span>OpenAI vision</span></label>
          <label className="toggle-label"><input type="checkbox" className="toggle-checkbox" disabled={!isLocal} checked={isLocal && enableFixes} onChange={(event) => setEnableFixes(event.target.checked)}/><Wrench size={16}/><span>Propose source fixes{!isLocal ? " (local projects)" : ""}</span></label></div>
        {enableExplore && <div className="exploration-controls">
          <label className="field-label">Step limit <input aria-label="Step limit" type="number" min={1} max={1000} value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))}/></label>
          <label className="field-label">State limit <input aria-label="State limit" type="number" min={1} max={1000} value={maxStates} onChange={(event) => setMaxStates(Number(event.target.value))}/></label>
          <label className="toggle-label"><input type="checkbox" checked={mockAgent} onChange={(event) => setMockAgent(event.target.checked)}/>Offline exploration agent</label>
        </div>}
        <details className="profile-picker"><summary>Job limits and model pricing</summary><p className="muted">Limits cover capture, pilot, replay, recovery and fixes together. Token and cost caps reserve the configured model ceiling before each AI request.</p>
          <div className="exploration-controls">
            <label className="field-label">Minutes <input aria-label="Minute limit" type="number" min={0.001} max={120} step="any" value={maxMinutes} onChange={(event) => setMaxMinutes(Number(event.target.value))}/></label>
            <label className="field-label">Action cap <input aria-label="Shared action cap" type="number" min={0} value={maxActions} onChange={(event) => setMaxActions(event.target.value)} placeholder="Optional"/></label>
            <label className="field-label">Token cap <input aria-label="Shared token cap" type="number" min={0} value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="Optional"/></label>
            <label className="field-label">Cost cap (USD) <input aria-label="Shared cost cap" type="number" min={0} step="any" value={maxCost} onChange={(event) => setMaxCost(event.target.value)} placeholder="Optional"/></label>
            <label className="field-label">OpenAI model <input aria-label="OpenAI model" value={model} onChange={(event) => setModel(event.target.value)} required/></label>
            <label className="field-label">Model input token ceiling <input aria-label="Model input token ceiling" type="number" min={1} value={modelCeiling} onChange={(event) => setModelCeiling(event.target.value)} placeholder="From model documentation"/></label>
            <label className="field-label">Input USD / million tokens <input aria-label="Input price per million" type="number" min={0} step="any" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} placeholder="Optional"/></label>
            <label className="field-label">Output USD / million tokens <input aria-label="Output price per million" type="number" min={0} step="any" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} placeholder="Optional"/></label>
          </div><p className="muted">Use your provider's current model ceiling and rates. Paid requests stop before dispatch if a requested cap lacks this configuration.</p>
        </details>
        {isLocal && <details className="profile-picker"><summary>Local dev server (optional)</summary><label className="field-label">Start command <input className="target-input compact-input" aria-label="Dev server command" value={startCommand} onChange={(event) => setStartCommand(event.target.value)} placeholder="pnpm exec vite --host 127.0.0.1 --port {port}"/></label><p className="muted">Leave empty to serve static files. Commands can use PORT or {'{port}'} for an available port.</p></details>}
      </form>
    </section>
    {(error || connectionError) && <div className="notice error-notice" role="alert"><AlertTriangle size={16}/>{error ?? connectionError}</div>}
    {copied && <div className="copy-toast" role="status">Copied to clipboard</div>}

    {live && <section className="glass-card progress-card" aria-label="Scan progress"><div className="progress-header"><strong>{live.status === "queued" ? "Queued" : "Scanning"}: {live.target}</strong><span>{live.progress.step} · {live.progress.completed}/{live.progress.total}</span></div>
      <div className="progress-track"><div className="progress-bar" style={{ width: `${Math.min(100, 100 * live.progress.completed / Math.max(1, live.progress.total))}%` }}/></div><p className="progress-detail">{live.progress.detail}</p></section>}
    {observed && <section className="glass-card fleet-panel" aria-label="Device fleet and agent activity"><div className="fleet-heading"><h2>Device sessions and agent activity</h2><span className="muted">{observed.usage.agentCalls} LLM calls · {observed.usage.agentTokens.toLocaleString()} tokens</span></div>
      <div className="fleet-grid">{Object.values(observed.fleet).map((device) => <div className="fleet-device" key={device.targetId}><strong>{device.name}</strong><span>{device.phase}{device.fidelity ? ` · ${device.fidelity}` : ""}</span>
        {typeof device.deviceInfo?.serial === "string" && <code>{device.deviceInfo.serial}</code>}{device.message && <p>{device.message}</p>}</div>)}
        {!Object.keys(observed.fleet).length && <p className="muted">{live ? "Waiting for device sessions…" : "Viewport scan"}</p>}</div>
      {agentEvents.length > 0 && <div className="agent-activity"><ol className="agent-log" aria-label="Agent action stream">{agentEvents.slice(-8).map((event) => {
        const observation = event.data as ExploreProgressEvent;
        return <li key={event.id}><span>{observation.phase} · step {observation.step} · {observation.deviceId}</span><strong>{observation.action ? JSON.stringify(observation.action) : observation.stateName ?? observation.message}</strong></li>;
      })}</ol>{latestShot && <img className="agent-observation" alt="Latest agent observation" src={artifactUrl(observed.artifactBaseUrl, latestShot)}/>}</div>}
    </section>}
    {observed?.usage.budget && <UsageMeter usage={observed.usage.budget}/>}
    {history.length > 0 && <section className="scan-history" aria-label="Scan history"><label className="field-label">Recent scans <select aria-label="Recent scans" value={reportJob?.id ?? ""} onChange={(event) => { const selected = history.find((item) => item.id === event.target.value); if (selected) showJob(selected); }}>
      <option value="">Choose a scan</option>{history.map((item) => <option key={item.id} value={item.id}>{item.target} · {item.status} · {new Date(item.createdAt).toLocaleTimeString()}</option>)}</select></label></section>}

    {currentReport && <section aria-label="Scan results">
      {currentReport.warnings?.map((warning) => <p className="notice" key={warning}>{warning}</p>)}
      {currentReport.errors?.map((failure) => <p className="notice error-notice" role="alert" key={failure.targetId}>{failure.targetId}: {failure.message}</p>)}
      <div className="kpi-grid"><div className="glass-card kpi-card kpi-total"><div className="kpi-label">Targets / states</div><div className="kpi-value">{currentReport.summary.totalViewports}</div></div>
        <div className="glass-card kpi-card kpi-critical"><div className="kpi-label">Critical defects</div><div className="kpi-value">{currentReport.summary.criticalFindings}</div></div>
        <div className="glass-card kpi-card kpi-warning"><div className="kpi-label">Warnings</div><div className="kpi-value">{currentReport.summary.warningFindings}</div></div>
        <div className="glass-card kpi-card kpi-pass"><div className="kpi-label">Clean states</div><div className="kpi-value">{currentReport.summary.passedViewports}</div></div></div>
      <div className="matrix-section-header"><div><h2>Device × state results</h2><p className="muted">Open a state to inspect its screenshot, findings and reproduction steps.</p></div><div className="matrix-presets">
        <button className={`preset-chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All ({currentReport.matrix.length})</button>
        <button className={`preset-chip ${filter === "failed" ? "active" : ""}`} onClick={() => setFilter("failed")}>Defects ({currentReport.matrix.filter((item) => item.status === "fail").length})</button>
        <button className={`preset-chip ${filter === "passed" ? "active" : ""}`} onClick={() => setFilter("passed")}>Clean ({currentReport.matrix.filter((item) => item.status === "pass").length})</button></div></div>
      <div className="matrix-grid">{filtered.map((item) => {
        const fidelity = item.device?.fidelity ?? "approximate";
        return <button key={item.renderId} type="button" className="device-card" aria-label={`Inspect ${item.name}${item.stateName ? ` — ${item.stateName}` : ""}`} onClick={() => inspect(item)}>
          <div className="device-preview"><img src={artifactUrl(artifactBase, item.annotatedRelPath)} alt={item.stateName ?? item.name} className="device-img" loading="lazy"/>
            <span className={`device-fidelity fidelity-${fidelity}`}>{fidelity}</span><span className={`status-ribbon ${item.status === "pass" ? "ribbon-pass" : "ribbon-fail"}`}>{item.status === "pass" ? <CheckCircle2 size={12}/> : <Bug size={12}/>} {item.findings.length} findings</span></div>
          <div className="device-details"><div className="device-title"><DeviceIcon item={item}/>{item.name}</div>{item.stateName && <p className="state-name">{item.stateName}</p>}
            <div className="device-meta">{item.viewport.width}×{item.viewport.height} @{item.viewport.deviceScaleFactor}x · {item.viewport.orientation}</div><div className="badge-row">
              {item.findingsCount.critical > 0 && <span className="pill-badge severity-critical">{item.findingsCount.critical} critical</span>}{item.findingsCount.warning > 0 && <span className="pill-badge severity-warning">{item.findingsCount.warning} warnings</span>}</div></div>
        </button>;
      })}</div>{!filtered.length && <p className="empty-state">No states match this filter.</p>}
      {(currentReport.fixes?.length ?? 0) > 0 && <section className="glass-card proposals-panel" aria-label="Proposed fixes"><h2>Proposed source fixes</h2><p className="muted">Review the saved diff and per-device verification evidence.</p>
        {currentReport.fixes!.map((patch) => <button className="proposal-row" key={patch.id} onClick={() => setActivePatch(patch)}><span>{patch.file}</span><span className={`verification status-${patch.verificationStatus}`}>{patch.verificationStatus}</span><span>Review patch</span></button>)}</section>}
      <div className="report-links"><a href={artifactUrl(artifactBase, "report.html")} target="_blank" rel="noreferrer">Open standalone report</a><a href={artifactUrl(artifactBase, "report.json")} download>Download JSON</a></div>
    </section>}
    {selectedItem && currentReport && <ReportInspector item={selectedItem} report={currentReport} base={artifactBase} onClose={() => setSelectedItem(null)} onPatch={setActivePatch} onCopy={copy} copied={copied} deviceFrame={deviceFrame} onDeviceFrame={setDeviceFrame}/>}
    {activePatch && currentReport && <PatchViewer patch={activePatch} report={currentReport} base={artifactBase} onClose={() => setActivePatch(null)} onCopy={copy}/>}
  </div>;
}

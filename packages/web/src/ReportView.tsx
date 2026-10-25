import { Copy, Download, ExternalLink, X } from "lucide-react";
import type { ProposedFixReport, RenderReportItem, ScanReport } from "@pixelsentinel/core";
import { artifactUrl } from "./api";

export function PatchViewer({ patch, report, base, onClose, onCopy }: {
  patch: ProposedFixReport; report: ScanReport; base: string; onClose: () => void; onCopy: (text: string) => void;
}) {
  const patchPath = `${report.config.output.dir.replace(/[\\/]$/, "")}/${patch.diffRelPath}`;
  const command = `git apply '${patchPath.replaceAll("'", "'\"'\"'")}'`;
  return <div className="modal-overlay" onClick={onClose}>
    <section className="modal-content patch-modal" role="dialog" aria-modal="true" aria-label={`Proposed patch for ${patch.file}`} onClick={(event) => event.stopPropagation()}>
      <div className="modal-nav"><div><h3>Proposed patch: {patch.file}</h3><span className={`verification status-${patch.verificationStatus}`}>{patch.verificationStatus}</span></div>
        <button className="icon-btn" aria-label="Close patch" onClick={onClose}><X size={20}/></button></div>
      <div className="patch-body">
        <p>{patch.explanation}</p><p className="muted">{patch.verificationMessage}</p>
        <pre className="diff-code" aria-label="Unified diff">{patch.diff}</pre>
        {patch.verifications?.map((check, index) => <details key={`${check.findingId}-${index}`} className="verification-detail">
          <summary>{check.targetId ?? check.findingId}: {check.status}</summary>
          <p>{check.message}</p><div className="evidence-pair">
            {check.beforeScreenshotRelPath && <figure><figcaption>Before</figcaption><a href={artifactUrl(base, check.beforeScreenshotRelPath)} target="_blank" rel="noreferrer"><img alt="Before patch" src={artifactUrl(base, check.beforeScreenshotRelPath)}/></a></figure>}
            {check.afterScreenshotRelPath && <figure><figcaption>After</figcaption><a href={artifactUrl(base, check.afterScreenshotRelPath)} target="_blank" rel="noreferrer"><img alt="After patch" src={artifactUrl(base, check.afterScreenshotRelPath)}/></a></figure>}
          </div></details>)}
        <p className="muted">Review the diff, then run this command from the source repository root.</p>
        <code className="apply-command">{command}</code>
        <div className="patch-actions"><a className="preset-chip" href={artifactUrl(base, patch.diffRelPath)} download><Download size={14}/> Download diff</a>
          <button className="primary-btn" onClick={() => onCopy(command)}><Copy size={16}/> Copy git apply command</button></div>
      </div>
    </section></div>;
}

export function ReportInspector({ item, report, base, onClose, onPatch, onCopy, copied, deviceFrame, onDeviceFrame }: {
  item: RenderReportItem; report: ScanReport; base: string; onClose: () => void;
  onPatch: (patch: ProposedFixReport) => void; onCopy: (text: string) => void; copied: string | null;
  deviceFrame: boolean; onDeviceFrame: (value: boolean) => void;
}) {
  const image = deviceFrame && item.deviceScreenshotRelPath ? item.deviceScreenshotRelPath : item.annotatedRelPath;
  return <div className="modal-overlay" onClick={onClose}>
    <section className="modal-content" role="dialog" aria-modal="true" aria-label={`Inspector: ${item.stateName ?? item.name}`} onClick={(event) => event.stopPropagation()}>
      <div className="modal-nav"><div><h3>{item.name}{item.stateName ? ` — ${item.stateName}` : ""}</h3>
        <span className="muted">{item.viewport.width}×{item.viewport.height} @{item.viewport.deviceScaleFactor}x · {item.device?.fidelity ?? "viewport approximation"}</span></div>
        <div className="patch-actions"><a href={artifactUrl(base, image)} target="_blank" rel="noreferrer" className="icon-btn" aria-label="Open screenshot"><ExternalLink size={18}/></a>
          <button className="icon-btn" aria-label="Close inspector" onClick={onClose}><X size={20}/></button></div></div>
      <div className="image-tabs"><button className={`preset-chip ${!deviceFrame ? "active" : ""}`} onClick={() => onDeviceFrame(false)}>Annotated page</button>
        {item.deviceScreenshotRelPath && <button className={`preset-chip ${deviceFrame ? "active" : ""}`} onClick={() => onDeviceFrame(true)}>Device frame</button>}</div>
      <div className="modal-split"><div className="screenshot-view"><img className="screenshot-img" src={artifactUrl(base, image)} alt={`${deviceFrame ? "Device frame" : "Annotated page"}: ${item.stateName ?? item.name}`}/></div>
        <div className="inspector-panel">
          {item.device && <p className="muted">{item.device.runtime} · {item.device.browser}{item.device.modifiers?.posture ? ` · ${item.device.modifiers.posture}` : ""}{item.device.modifiers?.fontScale ? ` · font ${item.device.modifiers.fontScale}×` : ""}</p>}
          {item.trace && item.trace.length > 0 && <details className="trace-detail" open><summary>How to reproduce ({item.trace.length} steps)</summary><ol>{item.trace.map((step, index) => <li key={index}>{step}</li>)}</ol></details>}
          {item.warnings?.map((warning) => <p className="notice" key={warning}>{warning}</p>)}
          <h4>Detected defects ({item.findings.length})</h4>
          {!item.findings.length && <p className="success-note">No defects detected in this state.</p>}
          {item.findings.map((finding, index) => {
            const patch = report.fixes?.find((candidate) => candidate.id === finding.proposedFixId || candidate.findingIds.includes(finding.id));
            return <article className="defect-item" key={finding.id}>
              <div className="defect-top"><div className="defect-badge"><span className={`num-tag severity-${finding.severity}`}>{index + 1}</span><span className="defect-type-tag">{finding.type}</span></div>
                <span className="source-tag">{finding.severity} · {Math.round(finding.confidence * 100)}%</span></div>
              <p className="defect-desc">{finding.description}</p>
              {finding.suggestedFix && <div className="fix-tip"><strong>Fix hint:</strong> {finding.suggestedFix}</div>}
              {finding.elements.map((element, elementIndex) => <button key={`${element.selector}-${elementIndex}`} className="dom-selector-btn" title="Copy CSS selector" onClick={() => onCopy(element.selector)}>
                <span>{element.selector}</span><span><Copy size={12}/> {copied === element.selector ? "COPIED" : "COPY"}</span></button>)}
              {patch && <button className="preset-chip" onClick={() => onPatch(patch)}>Review proposed diff · {patch.verificationStatus}</button>}
            </article>;
          })}
        </div></div>
    </section></div>;
}

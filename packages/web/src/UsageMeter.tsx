import type { UsageSnapshot } from "@pixelsentinel/core";

const dollars = (value: number | null) => value === null ? "Unknown" : "$" + value.toFixed(6);
export function UsageMeter({ usage }: { usage: UsageSnapshot }) {
  return <section className="glass-card usage-panel" aria-label="AI usage and budget">
    <div className="fleet-heading"><h2>AI usage and budget</h2><span>{usage.requests} requests · {usage.totalTokens.toLocaleString()} tokens · {dollars(usage.costUsd)} estimated</span></div>
    <div className="usage-table-wrap"><table><caption>Usage by phase</caption><thead><tr><th>Phase</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th><th>Estimated USD</th></tr></thead><tbody>
      {Object.entries(usage.phases).map(([phase, meter]) => <tr key={phase}><th scope="row">{phase}</th><td>{meter.requests}</td><td>{meter.promptTokens.toLocaleString()}</td><td>{meter.completionTokens.toLocaleString()}</td><td>{dollars(meter.costUsd)}</td></tr>)}
    </tbody></table></div>
    <p className="muted">Actions {usage.actions}{usage.limits.maxActions === undefined ? "" : ` / ${usage.limits.maxActions}`} · States {usage.states}{usage.limits.maxStates === undefined ? "" : ` / ${usage.limits.maxStates}`} · Cache hits {usage.cacheHits}</p>
    <p className="muted">Elapsed {(usage.elapsedMs / 1000).toFixed(1)}s · Time cap {usage.limits.maxMinutes} min</p>
    {usage.limits.maxTokens !== undefined && <p className="muted">Token cap: {usage.limits.maxTokens.toLocaleString()} · Reserved: {usage.reservedTokens.toLocaleString()}</p>}
    {usage.limits.maxCostUsd !== undefined && <p className="muted">Cost cap: ${usage.limits.maxCostUsd} · Reserved: {dollars(usage.reservedCostUsd)}</p>}
    {usage.costUsd === null && <p className="notice">Total cost is unknown. Known usage estimates {dollars(usage.knownCostUsd)}; missing prices or usage receipts are not counted as free requests.</p>}
    {usage.uncertainRequests > 0 && <p className="notice">{usage.uncertainRequests} requests lack usage receipts. Their conservative allocations remain reserved.</p>}
    {usage.stopped && <p className="notice error-notice" role="alert">{usage.stopped.message}</p>}
    <p className="muted">Dollar amounts use the configured model rates. Cached results make no new AI request.</p>
  </section>;
}

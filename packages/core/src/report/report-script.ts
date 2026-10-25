/** Inline report behavior. Text from scanned pages is always inserted as text, never executable HTML. */
export const REPORT_SCRIPT = String.raw`
const report = JSON.parse(document.getElementById('report-data').textContent);
let currentFilter = 'all';
let selectedItem = null;
let opener = null;
const h = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
};
const asset = (relative) => String(relative).split(/[\\/]/).map(encodeURIComponent).join('/');
const fidelity = (item) => item.device?.fidelity || 'approximate';
const label = (item) => item.name + (item.stateName ? ' — ' + item.stateName : '');
const button = (text, callback, className = 'filter-tab') => {
  const element = h('button', text, className);
  element.type = 'button'; element.onclick = callback; return element;
};
function screenshot(relative, alt) {
  const image = h('img'); image.src = asset(relative); image.alt = alt; image.loading = 'lazy'; return image;
}
function copy(text, element) {
  navigator.clipboard.writeText(text).then(() => { element.textContent = 'Copied'; })
    .catch(() => { element.title = 'Clipboard unavailable; select and copy the text'; });
}
function patchView(patch) {
  const detail = h('details', undefined, 'patch-detail');
  detail.append(h('summary', patch.verificationStatus.toUpperCase() + ' — ' + patch.file));
  detail.append(h('p', patch.explanation), h('p', patch.verificationMessage || '', 'report-muted'));
  detail.append(h('pre', patch.diff, 'patch-code'));
  const download = h('a', 'Download unified diff'); download.href = asset(patch.diffRelPath); download.download = '';
  detail.append(download);
  const patchPath = report.config.output.dir.replace(/[\\/]$/, '') + '/' + patch.diffRelPath;
  const command = "git apply '" + patchPath.replaceAll("'", "'\"'\"'") + "'";
  detail.append(h('p', 'Run from the source repository root after reviewing the diff.', 'report-muted'), h('code', command, 'apply-command'));
  const copyButton = button('Copy git apply command', () => copy(command, copyButton)); detail.append(copyButton);
  for (const verification of patch.verifications || []) {
    const evidence = h('details', undefined, 'verification-evidence');
    evidence.append(h('summary', (verification.targetId || verification.findingId) + ': ' + verification.status), h('p', verification.message || ''));
    const images = h('div', undefined, 'evidence-pair');
    for (const [name, relative] of [['Before', verification.beforeScreenshotRelPath], ['After', verification.afterScreenshotRelPath]]) {
      if (!relative) continue;
      const figure = h('figure'); figure.append(h('figcaption', name), screenshot(relative, name + ' patch')); images.append(figure);
    }
    evidence.append(images); detail.append(evidence);
  }
  return detail;
}
function renderMatrix() {
  const grid = document.getElementById('matrixGrid'); grid.replaceChildren();
  const filtered = report.matrix.filter((item) => currentFilter === 'all' || item.status === (currentFilter === 'failed' ? 'fail' : 'pass'));
  if (!filtered.length) { grid.append(h('p', 'No targets match this filter.', 'report-muted')); return; }
  for (const item of filtered) {
    const card = button('', () => { opener = card; openInspector(item); }, 'render-card');
    card.setAttribute('aria-label', 'Inspect ' + label(item));
    const thumb = h('div', undefined, 'render-thumb-wrapper');
    const image = screenshot(item.annotatedRelPath, label(item)); image.className = 'render-thumb'; thumb.append(image);
    const fid = fidelity(item);
    thumb.append(h('span', fid, 'fidelity-badge fidelity-' + (fid === 'approximate' ? 'approx' : fid)),
      h('span', item.status === 'pass' ? 'Pass' : item.findings.length + ' findings', 'thumb-badge ' + (item.status === 'pass' ? 'badge-pass' : 'badge-fail')));
    const info = h('div', undefined, 'render-info');
    info.append(h('div', item.name, 'render-title'));
    if (item.stateName) info.append(h('div', item.stateName, 'state-name'));
    info.append(h('div', item.viewport.width + '×' + item.viewport.height + ' @' + item.viewport.deviceScaleFactor + 'x · ' + item.viewport.orientation, 'render-specs'));
    const pills = h('div', undefined, 'render-pills');
    if (item.findingsCount.critical) pills.append(h('span', item.findingsCount.critical + ' critical', 'pill pill-critical'));
    if (item.findingsCount.warning) pills.append(h('span', item.findingsCount.warning + ' warnings', 'pill pill-warning'));
    if (!item.findings.length) pills.append(h('span', 'No defects detected', 'pill pill-pass'));
    info.append(pills); card.append(thumb, info); grid.append(card);
  }
}
function openInspector(item) {
  selectedItem = item;
  document.getElementById('modalTitle').textContent = label(item);
  document.getElementById('modalSubtitle').textContent = item.viewport.width + '×' + item.viewport.height + ' @' + item.viewport.deviceScaleFactor + 'x · ' + fidelity(item);
  const viewer = document.getElementById('viewerImg'); viewer.src = asset(item.annotatedRelPath); viewer.alt = 'Annotated page: ' + label(item);
  const tabs = document.getElementById('imageTabs'); tabs.replaceChildren();
  tabs.append(button('Annotated page', () => { viewer.src = asset(item.annotatedRelPath); viewer.alt = 'Annotated page: ' + label(item); }));
  if (item.deviceScreenshotRelPath) tabs.append(button('Device frame', () => { viewer.src = asset(item.deviceScreenshotRelPath); viewer.alt = 'Device frame: ' + label(item); }));
  const sidebar = document.getElementById('findingsSidebar'); sidebar.replaceChildren();
  if (item.trace?.length) {
    const trace = h('details', undefined, 'trace-box'); trace.open = true; trace.append(h('summary', 'How to reproduce (' + item.trace.length + ' steps)'));
    const list = h('ol'); for (const step of item.trace) list.append(h('li', step)); trace.append(list); sidebar.append(trace);
  }
  for (const warning of item.warnings || []) sidebar.append(h('p', warning, 'report-notice'));
  sidebar.append(h('h3', 'Findings (' + item.findings.length + ')'));
  if (!item.findings.length) sidebar.append(h('p', 'No defects detected in this state.', 'report-muted'));
  item.findings.forEach((finding, index) => {
    const card = h('article', undefined, 'finding-card');
    const header = h('div', undefined, 'finding-header');
    header.append(h('strong', (index + 1) + '. ' + finding.type), h('span', finding.severity + ' · ' + Math.round(finding.confidence * 100) + '%'));
    card.append(header, h('p', finding.description, 'finding-desc'));
    if (finding.suggestedFix) card.append(h('p', finding.suggestedFix, 'report-muted'));
    for (const element of finding.elements || []) {
      const copySelector = button(element.selector, () => copy(element.selector, copySelector), 'selector-box');
      copySelector.title = 'Copy CSS selector'; card.append(copySelector);
    }
    const patch = report.fixes?.find((candidate) => candidate.id === finding.proposedFixId || candidate.findingIds.includes(finding.id));
    if (patch) card.append(patchView(patch));
    sidebar.append(card);
  });
  document.getElementById('inspectorModal').classList.add('open');
  document.getElementById('closeModal').focus();
  document.body.style.overflow = 'hidden';
}
function closeInspector() {
  document.getElementById('inspectorModal').classList.remove('open');
  document.body.style.overflow = ''; selectedItem = null; opener?.focus();
}
document.getElementById('closeModal').onclick = closeInspector;
document.getElementById('inspectorModal').onclick = (event) => { if (event.target.id === 'inspectorModal') closeInspector(); };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && selectedItem) closeInspector(); });
document.getElementById('filterTabs').addEventListener('click', (event) => {
  if (!event.target.classList.contains('filter-tab')) return;
  for (const tab of document.querySelectorAll('#filterTabs .filter-tab')) tab.classList.remove('active');
  event.target.classList.add('active'); currentFilter = event.target.dataset.filter; renderMatrix();
});
const warnings = document.getElementById('reportWarnings');
for (const warning of report.warnings || []) warnings.append(h('p', warning, 'report-notice'));
for (const error of report.errors || []) warnings.append(h('p', error.targetId + ': ' + error.message, 'report-notice report-error'));
if (report.usage) {
  const usage = report.usage, panel = document.getElementById('usagePanel'); panel.hidden = false;
  const dollars = (value) => value === null ? 'Unknown' : '$' + value.toFixed(6);
  panel.append(h('h2', 'AI usage and budget'), h('p', usage.requests + ' requests · ' + usage.totalTokens.toLocaleString() + ' tokens · ' + dollars(usage.costUsd) + ' estimated'));
  const wrap = h('div', undefined, 'usage-table-wrap'), table = h('table'), head = h('thead'), header = h('tr'), body = h('tbody');
  for (const title of ['Phase', 'Requests', 'Input tokens', 'Output tokens', 'Estimated USD']) header.append(h('th', title));
  head.append(header);
  for (const [phase, meter] of Object.entries(usage.phases)) {
    const row = h('tr'), name = h('th', phase); name.scope = 'row'; row.append(name);
    for (const value of [meter.requests, meter.promptTokens, meter.completionTokens, dollars(meter.costUsd)]) row.append(h('td', String(value)));
    body.append(row);
  }
  table.append(head, body); wrap.append(table); panel.append(wrap);
  panel.append(h('p', 'Actions ' + usage.actions + (usage.limits.maxActions === undefined ? '' : ' / ' + usage.limits.maxActions) + ' · States ' + usage.states + ' · Cache hits ' + usage.cacheHits, 'report-muted'));
  panel.append(h('p', 'Elapsed ' + (usage.elapsedMs / 1000).toFixed(1) + 's · Time cap ' + usage.limits.maxMinutes + ' min', 'report-muted'));
  if (usage.limits.maxTokens !== undefined) panel.append(h('p', 'Token cap: ' + usage.limits.maxTokens + ' · Reserved: ' + usage.reservedTokens, 'report-muted'));
  if (usage.limits.maxCostUsd !== undefined) panel.append(h('p', 'Cost cap: $' + usage.limits.maxCostUsd + ' · Reserved: ' + dollars(usage.reservedCostUsd), 'report-muted'));
  if (usage.costUsd === null) panel.append(h('p', 'Total cost is unknown. Known usage estimates ' + dollars(usage.knownCostUsd) + '; missing prices or receipts are not free requests.', 'report-notice'));
  if (usage.uncertainRequests) panel.append(h('p', usage.uncertainRequests + ' requests lack usage receipts; conservative allocations remain reserved.', 'report-notice'));
  panel.append(h('p', 'Dollar amounts use configured model rates. Cached results make no new AI request.', 'report-muted'));
}
const fixes = document.getElementById('fixesPanel');
if (report.fixes?.length) {
  fixes.append(h('h2', 'Proposed source fixes'));
  for (const patch of report.fixes) fixes.append(patchView(patch));
}
renderMatrix();
`;

# PixelSentinel Phase 1 — Responsive Visual Defect Scanner

Build a TypeScript monorepo where a Playwright-based scanner renders a URL or local frontend project across a configurable device matrix, captures screenshots plus DOM/CSS metadata, sends screenshots to OpenAI vision for defect detection, correlates findings to DOM elements, and emits annotated screenshots and a report viewable via static HTML or a local web dashboard.

## Decisions (confirmed with user)
- **Stack:** TypeScript / Node 22, pnpm workspaces.
- **Vision API:** OpenAI (gpt-4o / gpt-4.1) via `openai` SDK with structured JSON output; provider interface kept pluggable.
- **UI:** CLI core emitting JSON + self-contained HTML report, plus a thin local web dashboard (Fastify API + Vite/React).
- **Browsers:** Chromium only (Playwright device descriptors for mobile emulation).
- Out of scope: YOLO training, physical devices, auto code repair.

## Repository layout
```
pixelsentinel/
  package.json               # pnpm workspace root, scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    core/                    # scanner + analysis library (no UI deps)
      src/
        config/              # schema (zod), defaults, matrix expansion
        target/              # URL vs local project resolution, static server
        capture/             # Playwright runner, screenshot + DOM snapshot
        vision/              # OpenAI provider, prompt, response schema
        heuristics/          # DOM-based overlap/clip/overflow detection
        correlate/           # map vision bboxes -> DOM elements
        annotate/            # draw boxes on screenshots (sharp)
        report/              # JSON + HTML report generators
        index.ts
      test/
    cli/                     # `pixelsentinel scan <url|dir>` (commander)
    server/                  # Fastify API: start scan, poll status, serve artifacts
    web/                     # Vite + React dashboard
  fixtures/                  # tiny static sites with known defects for tests
```

## Implementation steps

### 1. Scaffold monorepo
- `pnpm init`, workspace config, shared `tsconfig.base.json`, `tsx` for dev, `vitest` for tests, eslint/prettier.
- Add deps: `playwright`, `openai`, `zod`, `sharp`, `commander`, `fastify`, `@fastify/static`, `serve-handler` (or `sirv`) for local dirs, `pino` for logging.
- `.env.example` with `OPENAI_API_KEY`, `OPENAI_MODEL`.

### 2. Config & matrix (`core/src/config`)
- Zod schema for `ScanConfig`: `target`, `viewports[]` (name, width, height, dpr, orientation, `deviceDescriptor?`), `browser` (chromium), `fullPage`, `waitUntil`, `extraWaitMs`, `concurrency`, `vision: { model, maxImageDim, enabled }`, `output.dir`.
- Default matrix: desktop 1920x1080@1, 1366x768@1, 1280x720@1; tablet iPad @2 portrait/landscape; mobile iPhone 14, Pixel 7 @3 portrait/landscape; ultrawide 2560x1080; small 320x568.
- `expandMatrix()` produces a flat list of `RenderConfig`s with deterministic ids (`desktop-1920x1080-dpr1-landscape`).
- Support `pixelsentinel.config.(json|ts)` file + CLI overrides.

### 3. Target resolution (`core/src/target`)
- URL → use directly.
- Local directory containing `index.html` / `dist` / `build` → spin up static file server on an ephemeral port, return `http://localhost:PORT`.
- Local project needing a dev server → `--start "npm run dev" --port 5173 --ready-timeout`; spawn, wait for port, tear down after scan.

### 4. Capture (`core/src/capture`)
- One Chromium browser, N contexts in parallel (bounded by `concurrency`).
- Per `RenderConfig`: create context with viewport/DPR/isMobile/hasTouch, navigate, wait for network idle + fonts (`document.fonts.ready`) + `extraWaitMs`, disable animations via injected CSS, capture full-page PNG.
- Inject `dom-snapshot.js` (page.evaluate) that returns for every visible element: unique selector, tag, text snippet, `getBoundingClientRect` in CSS px, z-index, overflow, position, `scrollWidth`/`clientWidth`, computed font-size/line-height, `isClipped` flags. Capped to ~3k elements with depth/size pruning.
- Collect console errors, failed requests, horizontal scroll presence (`scrollWidth > innerWidth`).
- Output per render: `screenshot.png`, `dom.json`, `meta.json`.

### 5. Heuristic detectors (`core/src/heuristics`) — cheap, deterministic, run before vision
- **Horizontal overflow:** document scrollWidth > viewport.
- **Text overflow/clipping:** element `scrollWidth > clientWidth` with `overflow: hidden`, or text rect exceeding parent rect.
- **Overlap:** pairwise intersection of sibling/unrelated text+interactive rects (spatial grid to keep O(n log n)), ignoring ancestor-descendant pairs and intentional overlays (position fixed/absolute with z-index + backdrop).
- **Off-screen / clipped interactive:** button/link/input rect partially outside viewport or parent `overflow:hidden`.
- **Tiny tap targets:** interactive element < 24x24 CSS px on mobile configs.
- Emit `Finding` objects with `source: "heuristic"`, confidence, bbox, selector(s).

### 6. Vision analysis (`core/src/vision`)
- `VisionProvider` interface: `analyze(image: Buffer, ctx: RenderContext): Promise<VisionFinding[]>`.
- `OpenAIProvider`: downscale/tile tall full-page screenshots (max ~1568px edge; split into overlapping tiles with offset tracking), send with system prompt describing defect taxonomy (overlapping-text, clipped-element, broken-layout, obstructed-ui, misaligned, overflow, missing-content, unreadable-text) and request JSON (`zod` → `response_format: json_schema`) with normalized bboxes (0–1), severity, description.
- Also pass a compact DOM hint list (top ~40 interactive/text elements with rects) to improve grounding.
- Retry/backoff, token/cost logging, response caching keyed by image hash to avoid repeat spend.
- Offline `MockProvider` for tests.

### 7. Correlation (`core/src/correlate`)
- Convert vision bbox (normalized, tile-relative) → page CSS px.
- Match to DOM elements by IoU / containment against `dom.json`, prefer smallest element with IoU > threshold; attach selector, tag, text, relevant computed CSS.
- Deduplicate heuristic vs vision findings overlapping same region/elements; merge boosts confidence.
- Produce final `Finding { id, type, severity, confidence, sources[], bbox, elements[], description, renderId }`.

### 8. Annotation & report (`core/src/annotate`, `core/src/report`)
- `sharp` + SVG overlay: colored boxes per severity, numbered labels → `annotated.png`.
- `report.json`: scan metadata, matrix, per-render findings, summary matrix (render × defect-type counts, pass/fail).
- `report.html`: single-file template (inline CSS/JS, images referenced relatively) with matrix grid, filter by type/severity, click-to-view annotated screenshot with finding list and selectors.

### 9. CLI (`packages/cli`)
- `pixelsentinel scan <url|path> [--config] [--out] [--viewports ...] [--no-vision] [--concurrency] [--start --port] [--open]`.
- `pixelsentinel init` writes default config.
- Progress output via `ora`/plain log; exit code 1 if any failing render (configurable severity threshold) — CI friendly.

### 10. Server + Web dashboard (`packages/server`, `packages/web`)
- Fastify: `POST /api/scans` (config body) → job id; in-process queue; `GET /api/scans/:id` status/progress (SSE or poll); `GET /api/scans/:id/report`; static serving of artifacts.
- React/Vite: new-scan form (target, matrix presets, toggles), scan list, results page reusing the same matrix grid / annotated viewer components as the HTML report (share a `report-ui` component set, or build the HTML report by prerendering the same React components).
- `pixelsentinel serve` CLI command boots server + built web assets.

### 11. Fixtures & tests
- `fixtures/` static sites with seeded defects: overlapping absolute text, button clipped by `overflow:hidden`, horizontal overflow at 320px, fixed banner obstructing CTA, plus a clean baseline page.
- Vitest: matrix expansion, heuristics against fixture DOM snapshots, bbox conversion/correlation math, report generation; integration test running real Chromium against fixtures with `MockProvider`.
- Optional live test behind `OPENAI_API_KEY` guard.

## Verification
- [ ] `pnpm install && pnpm -r build && pnpm -r test` green
- [ ] `pnpm exec playwright install chromium` documented; `pixelsentinel scan fixtures/overlap --no-vision` reports heuristic findings for seeded defects, none on clean fixture
- [ ] `pixelsentinel scan https://example.com` with API key produces `report.html`, annotated PNGs, correct matrix summary
- [ ] `pixelsentinel serve` → dashboard submits a scan and renders results
- [ ] Lint + typecheck pass

## Risks / considerations
- **Vision cost & latency:** full-page screenshots × matrix can be many images; mitigate with tiling limits, image caching, `--no-vision`, per-scan budget cap.
- **Bbox precision from LLMs** is approximate; correlation uses DOM heuristics to snap to elements, and confidence is surfaced rather than asserted.
- **False positives** from intentional overlays (modals, sticky headers); heuristics whitelist common patterns and let config exclude selectors.
- **Dynamic content/animations** cause flaky captures; animations disabled, deterministic waits, optional `--block` for ad/analytics domains.
- **Local project dev servers** vary; the `--start/--port` escape hatch keeps Phase 1 generic.

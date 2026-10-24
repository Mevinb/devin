# PixelSentinel — Responsive Visual Defect Scanner

PixelSentinel is an automated visual QA scanner designed to detect visual rendering flaws across a device matrix (Desktop, Tablet, Mobile, and Ultrawide viewports) using Playwright Chromium, algorithmic heuristics, and OpenAI multimodal vision grounding.

---

## Features
- **11-Device Matrix Emulation:** Automatically tests UltraWide (2560x1080), FHD (1920x1080), Laptop (1366x768), iPad (portrait/landscape @2x), iPhone 14 (portrait/landscape @3x), Pixel 7 (portrait/landscape @3x), and Compact Mobile (320x568).
- **Fast Deterministic Heuristics:** Zero-API-cost detection of:
  - Horizontal viewport overflow (`scrollWidth > innerWidth`)
  - Container text clipping & truncation (`overflow: hidden`)
  - Unintended sibling element & text overlap
  - Clipped or off-screen interactive controls
  - Touch target accessibility (< 24x24px on mobile)
- **OpenAI Vision Grounding:** Multimodal analysis with smart screenshot tiling for tall pages, structured JSON outputs, and DOM hint grounding.
- **DOM Correlation:** Translates visual bounding boxes into exact DOM selectors, tags, and suggested CSS fixes with 1-click clipboard copying.
- **Sharp Image Annotator:** Color-coded severity boxes (Critical, Warning, Info) and numbered badges composited onto screenshots.
- **Reporting & Dashboard:**
  - Self-contained standalone HTML report (`report.html`) with interactive modal inspector.
  - Full structured JSON report (`report.json`).
  - React + Vite dark mode web dashboard with Fastify REST API.

---

## Monorepo Layout
```
├── packages/
│   ├── core/      # Scanner engine, Playwright runner, heuristics, vision, correlate, annotate
│   ├── cli/       # Command line interface (`pixelsentinel scan`, `init`, `serve`)
│   ├── server/    # Fastify REST API & artifact static file server
│   └── web/       # React + Vite interactive dashboard
└── fixtures/      # Seeded visual defect test cases (overlap, clipped, horizontal overflow, clean)
```

---

## Quickstart

### 1. Install & Build
```bash
pnpm install
pnpm build
```

### 2. Run a Visual Scan via CLI
```bash
# Scan a remote URL (heuristics only)
pnpm pixelsentinel scan https://example.com --no-vision

# Scan with OpenAI Vision enabled (requires OPENAI_API_KEY in .env)
pnpm pixelsentinel scan https://example.com

# Scan a local frontend directory
pnpm pixelsentinel scan ./fixtures/overlap --no-vision

# Automatically open HTML report in browser
pnpm pixelsentinel scan ./fixtures/clipped --open
```

### 3. Start the Web Dashboard
```bash
pnpm pixelsentinel serve
```
Open `http://localhost:3000` to launch scans from the web interface, view live progress, and explore the interactive viewport matrix.

### 4. Run Test Suite
```bash
pnpm test
```
Runs 12 Vitest unit and Playwright integration tests verifying matrix expansion, spatial correlation, and seeded defect detection on real Chromium browsers.

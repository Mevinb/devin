# PixelSentinel — Responsive Visual Defect Scanner

PixelSentinel is an automated visual QA scanner designed to detect visual rendering flaws across a device matrix (Desktop, Tablet, Mobile, and Ultrawide viewports) using Playwright Chromium, algorithmic heuristics, and OpenAI multimodal vision grounding.

Phase 2 is in progress. See [implementation status](PHASE2-STATUS.md) for verified
behavior and the remaining requirements from both phase plans.

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
│   ├── android/   # Android SDK, emulator profiles and diagnostics
│   ├── android-shell/ # Kotlin WebView host APK for non-Chrome Android targets
│   ├── fixer/     # Source patches and isolated browser verification
│   ├── cli/       # Command line interface (`pixelsentinel scan`, `init`, `serve`)
│   ├── server/    # Fastify REST API & artifact static file server
│   └── web/       # React + Vite interactive dashboard
└── fixtures/      # Static defects plus the six-state React/Vite flows app
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

# Select devices and configure the CI failure threshold
pnpm pixelsentinel scan ./fixtures/overlap --devices chromium:desktop-1080p --no-vision --fail-on warning

# Discover states with the offline agent, then replay its saved trace
pnpm pixelsentinel explore ./fixtures/flows --devices chromium:desktop-1080p --mock-agent --no-vision --max-steps 30 --max-states 6 --out ./pixelsentinel-output/flows --fail-on none
pnpm pixelsentinel replay ./pixelsentinel-output/flows/explore/trace.json --target ./fixtures/flows --devices chromium:desktop-1080p --mock-agent --no-vision --out ./pixelsentinel-output/replay
```

### 3. Start the Web Dashboard
```bash
pnpm pixelsentinel serve
```
Open `http://localhost:3000` to launch scans from the web interface, view live progress, and explore the interactive viewport matrix.

### 4. Run Test Suite
```bash
pnpm test
pnpm typecheck
```

`--out` must point to a separate artifact directory. The scanner rejects source
roots, their ancestors, symlink aliases and nonempty directories it cannot
identify as prior outputs. Cleanup removes generated artifact names and
preserves unrelated review notes in an owned output directory.
Runs Vitest unit and Chromium/WebKit integration tests covering matrix expansion,
seeded defects, exploration/replay, CLI behavior, and isolated patch verification.
Approximate devices are labelled and excluded from finding-based CI failures by
default; use `--fail-on-approximate` to include them. Capture failures always fail CI.

Install browser binaries with `pnpm --filter @pixelsentinel/core exec playwright install chromium webkit` if they are not already available.

Dashboard scans run in a queue with separate artifacts per job. Device selection,
exploration limits, live session/agent events, saved reproduction steps, and
actual proposal diffs are available in the dashboard. A patch is labelled
`verified` only after isolated browser verification; reviewing a proposal does
not change the scanned source tree. `pnpm test` builds all packages before
running the tests so browser checks use the current dashboard bundle.

## Android setup and real-device tests

Use JDK 17+ and, on Linux, a readable/writable `/dev/kvm` for new accelerated
emulator boots. An already-running matching AVD can be used through ADB even
when the scanner process cannot access KVM. `doctor` reports these separately.

```bash
# Choose writable, isolated locations; existing SDKs and AVDs are preserved.
export ANDROID_HOME="$PWD/.pixelsentinel/android/sdk"
export ANDROID_USER_HOME="$PWD/.pixelsentinel/android/user"
export ANDROID_AVD_HOME="$PWD/.pixelsentinel/android/avds"

pnpm pixelsentinel devices install --profiles pixel_8 --accept-licenses
pnpm pixelsentinel devices create pixel_8
pnpm pixelsentinel devices doctor --profiles pixel_8

# Fail if the real device cannot run, instead of using labelled approximation.
PIXELSENTINEL_STRICT_DEVICES=1 pnpm pixelsentinel scan fixtures/overlap --devices android:pixel-8 --no-vision --fail-on none

# Build and lint the WebView shell (Gradle/Android build dependencies download once).
pnpm pixelsentinel devices build-shell --accept-licenses
pnpm pixelsentinel devices install --profiles android_tv_1080p --accept-licenses
pnpm pixelsentinel devices create android_tv_1080p
PIXELSENTINEL_STRICT_DEVICES=1 pnpm pixelsentinel scan fixtures/device/focus-ring.html --devices android:tv-1080p --no-vision --fail-on none

# Opt-in real ps_phone checks. Include the APK/CDP/D-pad path after build-shell.
PIXELSENTINEL_RUN_SHELL_LIVE=1 pnpm test:android:live
```

`devices install --all` selects every built-in image. Each profile has its own
AVD, display properties and RAM requirement. The pool bounds concurrent owned
emulators by memory and instance count, and leases each AVD to one session at a
time. Existing connected emulators are borrowed and remain running afterwards.
New owned instances are stopped on shutdown unless
`PIXELSENTINEL_KEEP_EMULATORS=1` is set. Parallel clones and measured cold/snapshot
boot targets remain pending.

The shell artifact is `packages/android-shell/dist/pixelsentinel-shell.apk`;
`PIXELSENTINEL_SHELL_APK` can select another build. The runtime installs it with
`adb install -r`, attaches to its WebView via CDP, and reports fidelity as
`webview`. The phone test verifies this transport and real key events; separate
TV, Wear OS and Automotive runs are still needed. A debug shell enables remote
WebView debugging intentionally and is a testing tool.

The GitHub Actions workflow defines browser and KVM Android jobs, including
shell build/lint and uploaded test artifacts. Local checks do not imply that the
hosted workflow has run. See [verification status](PHASE2-STATUS.md) for evidence.

## Exploration and saved replay

All action sources use the same execution checks, including the offline agent,
saved traces and replay recovery. Destructive labels (including Delete, Pay and
Send), external destinations and malformed actions are blocked by default.
Checks use current labels and the actual hit target after scrolling. Keyboard
activation and coordinate taps follow the same policy. Use explicit opt-ins only
for test environments that permit those actions:

```bash
pnpm pixelsentinel explore ./fixtures/flows-app --devices chromium:desktop-1080p --mock-agent --no-vision --allow-destructive --fail-on none
pnpm pixelsentinel explore https://app.example --allowed-origins https://login.example --mock-agent --no-vision
pnpm pixelsentinel replay ./pixelsentinel-output/explore/trace.json --target ./fixtures/flows-app --devices chromium:desktop-1080p --mock-agent --no-vision --allow-destructive --fail-on none
```

Saved traces include their original start URL. Replay rebases same-origin
navigation to the new server and validates actions and state references before
starting. Missing steps, device failures and wrong states are saved in
`report.errors` and fail the CLI even with `--fail-on none`. That flag disables
finding thresholds; it does not turn an incomplete replay into a successful run.

Chromium enforces the navigation allow-list across HTTP redirect chains. On
WebKit/Firefox, controlled exploration currently rejects redirects when an
origin allow-list is active because their Playwright route callbacks cannot
validate the remaining chain. Navigate directly to an allowed landing URL for
those targets. Service-worker and popup parity still need broader validation.
Runtime exceptions remain findings even when the interaction leaves the DOM's
structural fingerprint unchanged. Live OpenAI behavior remains unverified;
current verification uses the offline agent and heuristics.

The [six-state React/Vite fixture](fixtures/flows/README.md) includes a dialog,
catalog, order table, contact form and validation state. The built `dist/` is
used for static scans. Use `--start 'pnpm exec vite --host 127.0.0.1 --port {port}'
--port 0` to scan its development source and propose mapped CSS/Sass-module
patches. Unbuilt TypeScript module entries produce a build/start instruction.
The original static fixture remains in `fixtures/flows-legacy`.

Captures record their image size, CSS bounds and scroll origin so DPR and
viewport-only images map correctly to elements and annotation boxes. Offline
SDK tests cover tile limits, DOM grounding, seam deduplication, context-sensitive
caching, retries and incomplete-response failures. They do not call OpenAI.

## Shared job limits and AI usage

Each scan, exploration or replay owns one budget, shared with any proposed-fix
generation and verification. The default active-work deadline is five minutes.
`--max-minutes`, `--max-actions`, `--max-tokens` and `--max-cost` override file
configuration for the whole job. Exploration/replay `--max-states` bounds unique
discovered states across devices; replaying an existing state does not consume
another state. `--max-steps` still limits each exploration agent independently.
The action limit includes attempted pilot, replay, recovery and fix-reproduction
actions. Failed attempts consume actions too.

Token/cost caps require a configured input-token ceiling for every model used;
a dollar cap also requires both input and output rates. These values are supplied
by the operator: PixelSentinel does not bundle current provider prices or model
limits. For example, the following uses **illustrative values**, which must be
replaced with the selected model's documented limits and rates:

```json
{
  "vision": { "model": "your-model-id" },
  "budget": {
    "maxMinutes": 5,
    "maxActions": 100,
    "maxStates": 6,
    "maxTokens": 200000,
    "maxCostUsd": 1,
    "models": {
      "your-model-id": {
        "contextTokens": 100000,
        "inputUsdPerMillion": 1,
        "outputUsdPerMillion": 2
      }
    }
  }
}
```

Before every model attempt, including retries and image tiles, the ledger
reserves the entire configured input ceiling plus the request's maximum output.
Valid usage receipts replace that reservation with measured token counts and
the configured price estimate. Concurrent calls share reservations. Failed calls
and missing/invalid receipts retain their allocation; missing prices or receipts
display an unknown total dollar cost. Cache hits make no new request. This is
conservative and may stop before the nominal cap is exhausted. The spend bound
depends on accurate configured ceilings/rates; it is not an invoice guarantee.
Reported usage beyond a configured ceiling stops further work explicitly.

The dashboard, SSE events, JSON and standalone HTML show usage for agent,
recovery, vision and fixer phases, along with limits, cache hits, reservations
and stop reasons. A stopped job retains completed captures and generated diffs;
interrupted verification stays `unverified`. Budget errors fail CLI/CI even with
`--fail-on none`. Deadline cancellation interrupts active browser/model work and
pending owned emulator boots. Artifact writing and resource cleanup may finish
after that deadline. Borrowed running emulators remain running.

Injected `VisionProvider` implementations must implement `withBudget(budget)`
and meter each paid attempt through `budget.request()`, or explicitly declare
`offline: true`. The built-in OpenAI provider creates a job-bound copy when
injected, preserving its client/cache without changing another job's ledger.
An optional analysis `signal` supports provider cleanup; the job also races the
analysis against its deadline. Offline providers must not dispatch paid calls.
All budget/SDK tests here use mocked responses; live billing and model behavior
remain unverified while testing is kept offline.

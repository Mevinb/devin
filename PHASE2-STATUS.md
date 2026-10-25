# PixelSentinel implementation and verification status

Updated: 2026-10-25. Requirements remain those in [Phase 1](plan.md) and
[Phase 2](plan-phase2.md). The broader goal is **paused for judging**, not complete.

## Judging stability fix (2026-10-25)

- Dashboard defaults now use one desktop target, offline analysis/exploration,
  and capture concurrency 1. The full fleet remains explicitly selectable.
  `bash judge.sh` serves the existing build with native runtimes approximated,
  without booting new emulators or dispatching OpenAI calls.
- A missing scan after a server restart previously left the UI polling a 404
  and permanently disabled Run scan. It now releases that missing job and
  presents a retry message. A Chromium regression reproduces the 404, checks
  the button recovers, then completes a new real scan. The targeted test passes.
- `run.sh` no longer kills an existing listener when launched again, which
  could discard its in-memory jobs. Both launchers pass shell syntax checks.
- The existing local app at port 5173 completed three captures without errors;
  a subsequent one-target scan also completed. Two prepared demo jobs completed:
  six React states with saved traces, and an overflow defect with a genuinely
  verified before/after patch. These use offline analysis.
- Source and build snapshot before the judging changes:
  `.pixelsentinel/backups/judging-20261025-070251.tar.gz` (598 files; excludes
  secrets, dependencies and caches). Existing sources/evidence remain in place.

## Verified in this continuation

- Fixed the fixer's missing direct Playwright dependency; all packages build.
- `scan --devices` now reaches the requested runtime instead of always scanning
  the eleven default viewports. Custom runtime objects retain their engine,
  Android/Windows settings and modifiers through Zod validation.
- CLI failure thresholds work, including `none` and explicit inclusion of
  approximate devices. A failed device capture remains an error in JSON and
  fails CI instead of silently disappearing from an otherwise clean scan.
- CLI defaults preserve file configuration. Added `explore`, `replay` and `init`;
  exploration uses the shared lifecycle with guaranteed runtime/target cleanup.
- Replay captures the final state when the pilot stopped at its step budget
  (previously only states preceding an action were captured).
- Source resolution uses live CDP CSS rules/source maps when available and
  structurally located CSS rules otherwise; ID-only selectors are supported.
  Component debug locations are carried through findings for fallback mapping.
- Deterministic patches edit CSS rule bodies, including embedded `<style>`
  blocks, and emit exact unified-diff hunk counts. No CSS is spliced into HTML
  attributes. Unsupported deterministic repairs are skipped with a reason.
- Worktrees use private Git metadata, leaving the original `.git` untouched and
  supporting read-only source metadata. They mirror current dirty/untracked
  source, reject nonexistent/escaping patch paths, and are removed afterwards.
- `verified` now requires browser proof: reproduce the original finding, apply
  the diff only in the worktree, restart/serve the copied project, replay its
  actions on the affected device/viewport, and show the original finding clears
  without new findings. Missing context/vision/runtime evidence stays
  `unverified`; a remaining defect or regression is `failed`.
- Browser tests cover a responsive table repair, unchanged dirty user source,
  retained before/after screenshots, a hidden state reached by actions, a patch
  that applies but does not fix the issue, a patch introducing new defects,
  and a copied dev server launched on an ephemeral port.
- Proposals group findings sharing a source rule; every affected finding gets
  verification evidence. Output includes `patches/<id>.diff`,
  `patches/index.json`, and compatible `fixes/proposals.json`. CLI report JSON
  links findings and proposed fixes.

## Six-state React fixture, source mapping and capture geometry (2026-10-25)

- `fixtures/flows` is now an actual React/Vite workspace package. Home, VIP
  dialog, catalog, checkout, contact form and invalid-input state are reached
  through ordinary controls. `fixtures/flows-legacy` preserves the previous
  static page. Builds generate `dist/`; static target resolution prefers built
  output and rejects unbuilt TS/TSX module entries with an actionable message.
- The offline pilot discovers all six states. A second desktop replays without
  recovery/LLM calls; approximate Android and WebKit reach all six with mobile
  menu recovery. Recovery attempts are scoped to each replay step, allowing a
  later step to reopen the same menu. High-z-index navigation is no longer
  incorrectly named a modal; semantic dialogs get their own heading.
- Strict desktop-to-phone replay also reached all six states in real Chrome
  on borrowed `emulator-5554`: 12 captures, no replay errors and zero LLM calls.
  Physical modal and validation-state frames were visually inspected. Evidence:
  `pixelsentinel-output/android-live/six-states`. The fixture's intentional
  seeded catalog overlap and mobile table overflow remain findings.
- Live Vite CSS ownership is resolved from `data-vite-dev-id` when CDP omits a
  stylesheet URL. Actual CSS source maps lead to the authored causal negative
  margin, and hashed CSS-module rules map back to `src/orders.module.scss`.
  Paths with spaces and quotes are covered. These are dev-server mappings;
  production/bundled and Tailwind coverage remains below.
- Source-map unmapped spans terminate earlier source ownership until a mapped
  segment resumes. Custom targets and legacy viewports retain their captured
  configuration for responsive rule lookup and isolated verification. Old
  reports can recover geometry from scan config; unknown geometry yields no CDP
  attribution. Inline styles served at `/` map to the actual `index.html`.
  Source/generated columns and selector offsets distinguish repeated selectors
  on the same minified line, including mobile media rules. Unresolved mapped
  spans never fall through to an invented authored line. Separate standards
  and requirement reviews found these edge cases; follow-up reviews report no
  remaining findings in this increment.
- Both seeded defects produce applicable diffs and pass isolated before/after
  browser verification. The overlap repair targets the negative margin. Table
  repairs preserve readable words and scroll all columns into view instead of
  forcing equal-width columns. Browser checks cover long identifiers, whole
  header words, page width and access to the final column. Screenshots were
  visually inspected, including the scrolled table.
- Worktree source and private Git metadata now live outside the source project
  in the OS temporary directory, avoiding reloads from the original Vite
  watcher. Dirty source and original Git status remain unchanged.
- Phase 1 viewport capture uses the shared capture/error-monitor pipeline.
  Metadata records raster dimensions, CSS image bounds, scroll origin and
  whether a full-page request fell back to viewport capture. Real Chromium
  DPR2 tests prove full-page/viewport correlation and actual annotation pixels.
  Original viewport IDs/descriptors and synthetic device geometry are retained;
  mobile/device viewport emulation is labelled approximate consistently during
  capture and patch verification.
- Vision tiles limit both sent dimensions, preserve original-image offsets,
  ground DOM hints in the correct coordinate system, and deduplicate seam
  findings. Configured `maxImageDim` is honored. Cache keys include context and
  processing settings; cache hits record zero new tokens. Responses are
  validated, aliases mapped to report defect types, and incomplete/failed
  analyses stay out of cache. Retryable failures use one bounded retry loop;
  permanent failures persist warnings in reports and capture metadata. All SDK
  request/response tests are mocked and make no external API calls.
- The agent advertises the full swipe/navigation/rotation/posture vocabulary
  and validates returned arguments with the executor's action schema. Offline
  SDK tests cover those tools and allowed-origin recovery. Real fold-posture
  and live model behavior are separate, unverified requirements.
- Output preparation rejects source roots, ancestors and symlink aliases before
  starting a runtime. Cleanup removes only recognized artifact names in an
  owned output directory, preserves other files, and recognizes legacy reports.
  Scan/exploration source-preservation regression tests pass.

## Server, dashboard and report verification (2026-10-25)

- Server jobs use shared `scan()` / `explore()` with validated device, vision,
  exploration-budget and proposal inputs. Jobs run sequentially with their own
  runtime registries and artifact directories; one scan cannot erase another's
  screenshots or close its active browser sessions.
- `/api/scans/:id/events` streams snapshots, actual agent actions, observation
  screenshots, progress and device lifecycle events. Event IDs and
  `Last-Event-ID` support reconnects. The client has a non-overlapping polling
  fallback and closes its stream when the job finishes.
- `/api/scans/:id/fixes` and the job's report expose the saved diff, its actual
  status, verification message and per-device before/after screenshots. The
  CLI, API, dashboard and standalone HTML share the same proposal report data.
- Dashboard device presets and profile selection now change the submitted
  device list. Exploration controls, local dev-server commands, source proposals,
  scan history, state names, fidelity badges, trace lists and the patch viewer
  are wired to actual job data. Sample diffs and fixed "Fleet Engine Ready"
  claims were removed.
- The live panel shows session boot/busy/released/error events with runtime
  identity, plus measured agent requests and tokens. Screenshots saved for
  agent action/recovery events are the observations supplied to that decision.
  A shared per-phase ledger now also reports vision/fixer usage and configured
  dollar estimates; its offline evidence is described below.
- Standalone HTML displays state names, real metadata fidelity, device-frame
  tabs, traces, actual patch diffs and verification evidence. Scanned page text,
  selectors and diff content are inserted as text rather than executable HTML.
- Browser checks exercise a real local scan and isolated verified patch, filters,
  screenshot inspector, clipboard commands, offline exploration, saved state
  traces, and standalone HTML. Desktop 1440px, phone 390px and compact 320px
  layouts are checked; rendered screenshots were visually inspected. The mobile
  Run button is at least 44px high. No app console errors, uncaught exceptions
  or framework overlays occurred in those flows.
- Missing OpenAI credentials and failed vision calls now produce report warnings
  instead of silently implying that AI analysis ran. API/browser tests use the
  offline agent and heuristic analysis; they do not prove live OpenAI behavior.

## Android provisioning, pool and connected-phone verification (2026-10-25)

- `devices install`, `create`, `doctor` and `build-shell` are wired to maintained
  implementations. SDK bootstrap downloads an official pinned archive, checks
  SHA-256 before extraction, installs only missing packages, verifies payloads,
  and uses argument arrays for paths containing spaces/quotes. Existing SDK
  tools/packages and AVDs are preserved unless replacement is explicitly selected.
- Ten canonical profiles provide distinct AVD names, real hardware presets,
  RAM/display properties and available system-image IDs. Chrome profiles use
  Play Store images; TV API 36 and Automotive API 33 replace nonexistent older
  image IDs. Runtime targets and the provisioning CLI share these definitions.
- Doctor checks SDK tools, JDK, image/AVD compatibility, writable storage, KVM
  and memory. It reports new-boot readiness separately from connected-device
  access and exits nonzero when new accelerated boots cannot run. Strict device
  mode also rejects missing-device/forced-approximation fallbacks.
- The shared pool enforces exclusive session leases, instance and RAM limits,
  idle owned-instance eviction, health/restart checks, boot-failure cleanup and
  shutdown recovery. Simulated-host tests cover these transitions; borrowed
  connected emulators are never killed by pool cleanup.
- Installed official tools, platform-tools, emulator and the API 35 Play Store
  image into `.pixelsentinel/android/sdk-managed`, using isolated preferences
  and AVD directories. Actual avdmanager created phone and tablet configurations
  with the expected hardware, image, dimensions, density and RAM. The original
  SDK and AVD directory were preserved.
- Connected `ps_phone` / `emulator-5554` was revalidated. Strict scans produced
  findings and physical device frames from real Chrome. Live tests pass for
  portrait + landscape captures, restoration of the prior rotation, a real IME
  probe, and dashboard switching between page annotations and device frames.
  The dashboard screenshot was visually inspected.
- Fixed a live orientation race: default phone scans now apply and await their
  requested orientation before capturing, just like explicit orientation scans.
  Session cleanup restores prior display, rotation, font, night-mode and debug
  app settings instead of blindly resetting a borrowed emulator's settings.
- The Kotlin shell builds a signed debug APK and runs Android lint. It accepts
  a web URL from intent data or a `url` extra, exposes debug WebView CDP, supports
  touch/D-pad focus, and blocks native/custom/file URL handoff. Build dependencies,
  Gradle cache and signing state can live in the workspace. Normal TypeScript
  builds do not require an SDK. The runtime reinstalls the current APK with `-r`
  and reports `webview` fidelity.
- The built APK passed its live phone test: real WebView/CDP scan found the
  seeded overlap and saved a physical device frame. Actual ADB arrow/center keys
  moved focus and activated Settings. WebView did not provide spatial focus
  automatically on this phone, so D-pad mode injects a tested fallback that
  preserves prevented/custom key handling and editable fields. The page and
  device screenshots were visually inspected; this is phone transport/input
  evidence, not a claim that a TV/Wear/Automotive image has been booted.
- The current capture continuation reran all four opt-in Android tests together
  successfully. A reproduced first-touch IME failure now gets one bounded retry
  on the same editable field. Keyboard measurements wait for viewport/pan
  stability, support layout resize, and record focus/attempt/stability evidence;
  submit/button inputs are excluded. A transient obstruction measurement was
  corrected after comparing the actual keyboard frame. The settled capture
  correctly records Chrome panning the input into view. Borrowed device state
  and scan scroll positions are restored after checks.
- `.github/workflows/qa.yml` defines browser and KVM Android jobs with pinned
  actions, JDK 17, shell build/lint, real phone tests and artifact upload. The
  workflow parses locally; hosted execution is **not verified**.
- `/dev/kvm` is unavailable in this restricted process. Isolated-SDK doctor now
  passes SDK/AVD/storage checks and reports that KVM limitation honestly. A
  borrowed running phone is separate evidence from an owned cold boot: new
  boot/snapshot timings, parallel clones, and other form factors remain pending.

## Exploration guards and saved replay (2026-10-25)

- Pilot actions, saved replay and recovery now share the same execution policy.
  It validates action shapes, checks current accessible labels and actual hit
  targets (including coordinates/keyboard activation), rejects external links,
  form destinations and navigation by default, and honors explicit
  `--allow-destructive` / `--allowed-origins` opt-ins.
- Chromium checks every HTTP redirect response through CDP, covering the
  redirect callbacks that Playwright skips. Tests prove that scripted redirects
  and multi-hop redirects never contact the outside fixture server, while an
  allowed internal redirect still reaches its actual landing URL. WebKit takes
  a conservative path that rejects unchecked redirects; normal internal
  redirect support there, service-worker and popup coverage remain open.
- Corrected mobile hit-testing after scroll: CDP input points require the
  visual viewport offset before DOM hit-testing on horizontally overflowing
  pages. The responsive replay test exposed this and now passes with the guard.
- Saved JSON is validated for actions, unique states, step indices and state
  references. Traces record their start URL; navigation is rebased to the new
  server. Replay also checks that the expected state was reached instead of
  accepting any successful click as proof of the recorded state.
- Divergence and secondary-device launch errors persist in `report.errors`.
  `scan --explore` and `replay` fail CI on those errors, including with
  `--fail-on none`. CLI finding thresholds remain configurable independently.
  Existing dashboard and standalone error panels consume the shared errors.
- Exceptions raised without a structural DOM change are merged into the
  existing state's findings and `meta.json`, with the actions that caused them.
  Error IDs are stable per message/capture, and error merging does not repeat
  vision calls. Replay captures no longer probe inputs and mutate the state
  before executing its trace.
- An additional strict run on the borrowed real phone captured three Chrome
  states from `fixtures/flows-app`, including its trial modal, with physical
  device frames and zero LLM calls. Artifacts:
  `pixelsentinel-output/android-live/explore-guards`. The modal frame was
  visually inspected. The six-state React fixture is now separately verified
  on the connected phone as described above.
- User selected **keep testing offline**. The configured OpenAI key was not
  changed or used; tests explicitly disable API access. Live model behavior
  remains unverified.

## Shared budgets, usage and cancellation (2026-10-25)

- Scan, pilot/per-device exploration, replay/recovery, vision, source attribution,
  patch generation and patch verification share one job ledger. A five-minute
  default deadline, attempted-action cap and unique-state limit apply across
  devices. Already-known states can replay without another discovery charge.
  A global state cap lower than the agent's cap does not leave an uncaptured
  destination or an unfinished step in the saved trace.
- Each SDK attempt reserves the configured model input ceiling plus its maximum
  output before dispatch. Concurrent phases share token/dollar reservations.
  Valid receipts settle actual tokens at operator-configured rates; failed or
  receiptless requests keep their conservative allocation. Missing prices or
  usage make total cost unknown rather than zero. Cached analyses record cache
  hits without new requests. No current model prices/limits are bundled; cap
  guarantees depend on accurate configured ceilings and rates, and these amounts
  remain estimates rather than provider invoice verification.
- All owned SDK retries/tiles use the same ledger with SDK retries disabled.
  Injected OpenAI providers get independent job-bound copies sharing the SDK
  client/cache. Other injected providers must implement per-attempt budget
  binding or declare themselves offline. Hanging injected analyses are bounded
  by the deadline and receive its AbortSignal.
- CLI scan/explore/replay, API validation, SSE usage events, the React dashboard
  and standalone HTML expose limits, measured requests/tokens, per-phase dollar
  estimates, reservations and stop reasons. Budget stops preserve partial
  reports and generated diffs and fail CI even with `--fail-on none`. Incomplete
  AFTER vision verification retains screenshots and an `unverified` proposal.
- Real Chromium/WebKit lifecycle tests defer browser launch until after shutdown
  and verify late handles close before context creation. Android/Windows fallback
  paths use the same ownership checks. Pending navigation, dev-server readiness
  and hanging source-map fetches are actually interrupted locally. Simulated-host
  pool tests prove pending owned boots and queued leases cancel while healthy
  warm/borrowed instances remain available. Real owned-boot cancellation remains
  a KVM-host requirement. Reporting and cleanup may finish after the deadline.
- Two independent read-only reviews found late-launch leaks, incomplete vision
  verification, uncancelled source-map fetches and a state-cap trace edge case.
  These were repaired with regression tests; follow-up reviews found no remaining
  defects in those fixes or the injected-provider integration.
- A real-phone rerun exposed a transient IME resize followed by a settled frame
  with no keyboard. The probe now bases its bounded retry on the settled focused
  viewport measurement. A browser timing regression reproduced the failure
  before the repair and passes afterwards; device validation is recorded below.
- All model accounting/receipt tests use mocked SDK responses and explicit fake
  credentials. No live OpenAI analysis or billing calls were made. Desktop and
  compact-phone budget panels were rendered and visually inspected; the wide
  phase table scrolls inside the panel without widening the page.

## Evidence and commands

- `packages/core/test/config.test.ts`: matrix and custom runtime config.
- `packages/core/test/budget.test.ts` and `run-budget.test.ts`: cross-phase
  concurrent reservations, configured/unknown costs, uncertain receipts, shared
  action/state limits, partial reports and real navigation deadline cancellation.
- `packages/core/test/browser-lifecycle.test.ts` and
  `packages/fixer/test/lifecycle.test.ts`: late browser ownership and actual
  hanging source-map fetch cancellation. `target.test.ts` also checks cancellation
  of a real pending dev-server process.
- `packages/fixer/test/budget.test.ts`: one ledger across all four SDK phases
  using mocked receipts, cap denial before dispatch, and unverified retained
  evidence when a configured vision pass cannot complete.
- `packages/core/test/integration.test.ts`: real Chromium against clean,
  overflow, overlap and clipping fixtures.
- `packages/core/test/scanner-failures.test.ts`: failed device retained in a
  partially successful scan and persisted report; CI exit policy; uncaught
  exceptions, unhandled rejections and console errors during a Phase 1 scan.
- `packages/core/test/runtime.test.ts`: Chromium/WebKit controls and honest
  Android/Windows approximation.
- `packages/core/test/explore.test.ts`: pilot/replay, responsive hamburger
  recovery, runtime exceptions and retention of exceptions in deduplicated states.
- `packages/core/test/explore-actions.test.ts`: current labels, coordinates,
  keyboard activation, mock recovery, explicit opt-ins, redirect chains,
  malformed inputs, WebKit's redirect failure and posture dispatch.
- `packages/core/test/replay.test.ts`: a different local server/port, persisted
  divergence, wrong-state detection, and invalid saved trace rejection.
- `packages/core/test/target.test.ts`, `mock-agent.test.ts`, `agent-tools.test.ts`
  and `output.test.ts`: built/source entries, semantic state names, state-aware
  action reuse, repeated menu recovery, full tool schemas and safe cleanup.
- `packages/core/test/capture-geometry.test.ts` and `vision-provider.test.ts`:
  real DPR2/scroll/fallback capture, image annotation pixels, shared Phase 1
  errors, bounded settled-IME retry, tile geometry, context caching, retries,
  incomplete model responses and injected-provider budget/deadline enforcement.
- `packages/cli/test/cli.test.ts`: actual subprocess commands, selected devices,
  CI thresholds, config defaults, saved-trace replay, and clean termination.
- `packages/fixer/test/fixer.test.ts`: real browser verification and worktree
  isolation, including a local dev server.
- `packages/fixer/test/mapping.test.ts`: `git apply --check` on generated hunks,
  embedded CSS boundaries, sourcemap gaps and source path boundaries.
- `packages/fixer/test/vite-fixture.test.ts`: actual React/Vite development
  server, authored CSS and Sass-module source maps, isolated verified patches,
  unchanged source/Git status and readable scrollable table content.
- `packages/server/test/server.test.ts`: actual API validation, queued jobs,
  independent artifacts, finite/resumable SSE, selected exploration devices,
  verified proposal downloads, and unchanged target source.
- `packages/server/test/dashboard.test.ts`: the built dashboard and standalone
  HTML in real Chromium; full scan/patch/trace/filter/clipboard interactions and
  responsive layouts. Browser plugin was not listed; the existing project
  Playwright setup was used.
- `packages/core/test/report-ui.test.ts`: inert hostile page text and quoted
  selectors, clipboard round trip, state traces and device-frame switching.
  Device-frame metadata in this renderer test is a labelled synthetic fixture,
  not evidence of a hardware/device capture.
- `packages/android/test/bootstrap.test.ts`: checksum rejection/extraction,
  exact package arguments, preserved installations/AVDs, profile definitions,
  zero-exit incomplete installs, isolated shell build dependencies.
- `packages/cli/test/devices.test.ts`: actual doctor/install/create subprocesses,
  selected SDK paths and rejection of unknown profiles before download.
- `packages/core/test/emulator-pool.test.ts`: leases, RAM/count bounds, idle
  eviction, health/restart, failed boots, shutdown and borrowed-device cleanup.
- `packages/core/test/android-live.test.ts`: opt-in real phone orientation, IME,
  dashboard device frames, plus an additional APK/CDP/D-pad test selected with
  `PIXELSENTINEL_RUN_SHELL_LIVE=1` after building the shell.
- `packages/core/test/shell-dpad.test.ts`: spatial focus in real Chromium,
  activation, hidden-control exclusion, and preservation of custom key/caret behavior.
- Screenshots: `/tmp/pixelsentinel-qa/dashboard-desktop.png`,
  `dashboard-mobile.png`, `inspector-mobile.png`, `verified-patch.png`,
  `exploration-states.png`, `standalone-mobile.png`, `budget-desktop.png`,
  `budget-mobile.png`.
  Real phone dashboard: `/tmp/pixelsentinel-qa/real-android-frame.png`;
  reports/device/IME artifacts: `pixelsentinel-output/android-live`.
  React/Sass patch evidence: `/tmp/pixelsentinel-qa/vite-fixture/`, including
  `before.png`, `after.png`, `sass-before.png`, `sass-after.png` and
  `sass-after-scrolled.png` plus the verified diffs.
  DPR2 viewport annotation evidence: `/tmp/pixelsentinel-qa/capture-geometry/`;
  the saved image was visually inspected against the recorded scroll origin.
- Full gates: `pnpm build`, `pnpm typecheck`, `pnpm test`, `git diff --check`.
  Current full-suite result before the judging-only recovery change:
  **147 tests passed across 32 files**, with four
  opt-in live tests skipped in that default run. All **four local live Android
  tests passed together separately** after the capture/IME changes. The current
  previous capture continuation also replayed all six React fixture states on
  the real phone with zero LLM calls and no replay errors. The later budget
  replay could not start after the borrowed emulator became unreachable; its
  device error was retained rather than counted as a successful phone replay.
  `devices build-shell` completed
  assemble + Android lint (**no issues found**); `apksigner verify` passed.
  Typecheck, frozen lockfile install and `git diff --check` also passed.
  In this restricted session npm's cache is redirected with
  `npm_config_cache=/tmp/pixelsentinel-npm-cache`; this is an environment detail,
  not a required project setting.

## Remaining Phase 1 requirements to close with evidence

1. Verify live OpenAI analysis and actual device-frame vision. Shared token/cost
   accounting, cap reservations and deadline cancellation now have offline
   regression coverage; live billing/model behavior remains unverified.
2. Complete fixture coverage for obstructing banners and exclusion/intentional
   overlay behavior; add report behavior checks beyond JSON assertions.
3. Finish lint/format tooling and run the specified gates (there is currently no
   root lint command).
4. Extend dashboard evidence from the verified local/offline paths above to live
   OpenAI analysis and real device runtimes after those implementations are ready.
5. Verify/document all CLI options and local dev server readiness/cleanup,
   including project-specific start commands. For generic verification servers,
   use a command honoring `PORT` or `{port}`, e.g.
   `--start "pnpm exec vite --host 127.0.0.1 --port {port}" --port 0`.

## Remaining Phase 2 work, in implementation order

### 1. Remaining telemetry and UI coverage

- Validate configured dollar estimates against live provider usage when live
  testing is authorized. Per-phase accounting and shared caps are implemented
  and tested with mocked SDK receipts; no real billing calls were made.
- Extend verified real-phone serial/device frames to owned boots and the other
  form factors, including posture transitions.
- Exercise polling fallback/reconnect and failed/cancelled job UX under network
  interruption. Existing API tests prove finite streams and Last-Event-ID.
- Extend real-phone dashboard device-frame switching to TV/Wear/Automotive.

### 2. Remaining device management and real form factors

- Verify owned cold boot <90 s, warm snapshot boot <15 s, snapshot persistence,
  read-only parallel clones and cleanup on a KVM-capable host. Pool transitions
  are tested, but those real boot/performance requirements are still open.
- Run the built `packages/android-shell` APK on TV/Wear/Automotive and prove
  WebView CDP, device screenshots, D-pad focus/navigation on those form factors.
- Publish a built shell APK through the project's release process after review;
  the local debug artifact exists, but no release was published here.
- Complete/test posture, rotation, font/display scale, dark mode, safe-area,
  keyboard, hinge and overscan axes against actual device evidence.
- Real phone Chrome/rotation/IME and dashboard frames are now revalidated;
  labelled approximate heuristic tests are still separate from form-factor proof.

### 3. Exploration completeness

- Extend the shared deadline and owned-resource cancellation evidence to real
  owned emulator boots/snapshot resumes on a KVM-capable host. Browser, SDK,
  source-map, dev-server and simulated boot cancellation are tested locally.
- Verify advertised posture changes against a real foldable; the action
  executor propagates unsupported-device/control failures. Full schema and
  mocked SDK tests do not prove live model behavior.
- Extend origin-policy proof to service workers, popups, embedded frames and
  Windows Firefox; support allowed redirect chains in non-CDP runtimes without
  weakening the allow-list. Current WebKit behavior fails closed on redirects.

### 4. Fixer completeness beyond the verified static/dev-server slice

- Extend the verified Vite development CSS/Sass/module mappings to production
  bundles and Tailwind-generated styles with available source maps.
- Supply screenshot crops and computed-style/framework context to AI patch
  generation. Live AI patch generation has not been tested here.
- Produce before/after crops as well as full screenshots. Full before/after
  screenshots and per-device verification messages now appear in both report UIs.
- Verify explicit `fixes list/show/apply` commands against a throwaway repository,
  including failed/stale patch exit codes and cleanup.
- Support/verify generic build/start commands for frameworks that ignore PORT;
  such patches must remain unverified until a copied server really responds.

### 5. Windows and CI

- Finish `devices windows init --iso`, unattended provisioning, snapshot restore,
  real Edge/Chrome/Firefox endpoints, and guest resolution/DPI changes.
- Verify honest fallback without a VM and a real Windows @150% scan when a
  user-provided ISO/endpoint is available. The existing VM code is a skeleton;
  an approximate Chromium run is not Windows verification.
- Execute the prepared KVM Android GitHub Actions job on the provider and inspect
  uploaded evidence; its source and applicable local checks are ready separately.

Native/hybrid APK support remains the explicitly optional, unconfirmed extension
in the Phase 2 plan, after all required web-device paths above.

## Environment and implementation gotchas

- Real emulator configuration uses `ANDROID_HOME`/`ANDROID_SDK_ROOT` or
  `~/Android/Sdk`. Play Store images provide Chrome; generic google_apis images
  may not. Chrome first-run UI can steal focus.
- Device test flags: `PIXELSENTINEL_DEVICES=approximate`,
  `PIXELSENTINEL_STRICT_DEVICES=1`, `PIXELSENTINEL_KEEP_EMULATORS=1`,
  `PIXELSENTINEL_SHELL_APK`, `PIXELSENTINEL_WINDOWS_ENDPOINT`.
- Stable selectors must replace per-snapshot `el-N` ids during replay. Scroll
  elements into view before viewport-coordinate taps.
- Mobile Chrome may widen innerWidth around overflowing content; compare with
  screen width where appropriate. Annotation coordinates need DPR scaling.
- `tsx` browser evaluations may need the shared `__name` shim in snapshotPage.
- Root `.android-test.mts` / `.boot-test.mts` are inherited scratch scripts;
  retain until their device checks are represented by maintained tests.

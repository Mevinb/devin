# PixelSentinel Phase 2 — Real Device Runtimes, Autonomous Exploration, Fix Proposals

Phase 1 renders a URL in headless Chromium with Playwright *device descriptors* (fake viewport/DPR/UA). Phase 2 replaces that approximation with **real device runtimes** (Android emulators across every Android form factor, a Windows desktop VM, WebKit for iOS), lets an **LLM agent actually use the app** on those devices, and turns findings into **reviewable source patches** without touching the user's working tree.

## Decisions (confirmed with user)
- **Runtimes:** Android emulators (phones, tablets, foldables, Android TV, Wear OS, Automotive) + Windows desktop VM (Edge/Chrome/Firefox). iOS/macOS Safari approximated with Playwright WebKit and flagged `approximate` in reports (no macOS host available).
- **Interaction:** LLM-driven exploration (agent decides taps/typing/scrolls within a budget).
- **Auto-fix:** propose patches only — emit diffs, never modify the user's source tree.
- **Assumption (not confirmed):** primary target stays a *web app* rendered in the real browser on each device. Native/hybrid APK support is designed in (Appium already in the stack) but scheduled last as optional.
- Host facts: Linux, `/dev/kvm` present, `adb` present, **no Android SDK / emulator installed**, no Docker. Node 22.

## Honest constraints to surface in the UI
| Runtime | Real browser available? | What we do |
|---|---|---|
| Android phone / tablet / foldable | Yes — Chrome | Real Chrome via emulator, full fidelity |
| Android TV | No Chrome on TV images | Web targets: WebView shell app (ours) + D-pad navigation; or native APK. Marked `webview` |
| Wear OS | No browser | Native APK only, or WebView shell. Marked `webview` |
| Automotive OS | WebView only | WebView shell app. Marked `webview` |
| Windows desktop | Yes — Edge, Chrome, Firefox | Real Windows VM, real fonts/scrollbars/DPI |
| iOS / macOS Safari | No (needs macOS) | Playwright WebKit, marked `approximate` |

The **WebView shell** is a tiny Android app we build once (`packages/android-shell`): a full-screen WebView that loads a URL from an intent extra, exposes CDP via `WebView.setWebContentsDebuggingEnabled(true)`. It gives us a real Android rendering engine on TV/Wear/Auto where no browser exists.

## Architecture changes

### 1. `DeviceRuntime` abstraction (`core/src/runtime`)
Replace `CaptureRunner`'s hard-coded `chromium.launch` with a provider interface:

```ts
interface DeviceRuntime {
  id: string;                        // "android:pixel_8", "windows:edge", "webkit:iphone-15"
  kind: "playwright" | "android" | "windows-vm";
  fidelity: "real" | "webview" | "approximate";
  acquire(): Promise<DeviceSession>;  // boots/leases emulator or VM, returns ready session
  release(s: DeviceSession): Promise<void>;
}
interface DeviceSession {
  page: Page;                        // Playwright Page (via CDP or remote server) — reuses all Phase 1 capture code
  device: DeviceControl;             // rotate(), setPosture(), pressKey("DPAD_DOWN"), setFontScale(), installApp()
  screenshot(): Promise<Buffer>;     // device-level screenshot (includes system UI, keyboard) — in addition to page.screenshot
  a11yTree(): Promise<A11yNode[]>;   // for the agent
}
```

Key insight: **every runtime still yields a Playwright `Page`**, so `dom-snapshot.ts`, heuristics, correlation and annotation are unchanged.
- Android Chrome/WebView: `adb forward tcp:<port> localabstract:chrome_devtools_remote` → `chromium.connectOverCDP()`.
- Windows VM: `npx playwright run-server` inside the VM → `chromium.connect(ws)` with `channel: "msedge" | "chrome"` and `firefox.connect`.
- WebKit: `webkit.launch()` locally.
- Device-level control (rotate, fold, D-pad, install, app lifecycle): **Appium UiAutomator2** driven from Node via `webdriverio`. Appium also owns the native-APK path later.

Config: `viewports[]` becomes `devices[]`:
```json
{ "runtime": "android", "profile": "pixel_fold", "postures": ["folded","unfolded"], "orientations": ["portrait","landscape"], "browser": "chrome" }
{ "runtime": "android", "profile": "tv_1080p", "input": "dpad", "browser": "webview-shell" }
{ "runtime": "windows", "browsers": ["msedge","chrome","firefox"], "resolutions": ["1920x1080@1","2560x1440@1.5"] }
{ "runtime": "webkit", "profile": "iPhone 15", "fidelity": "approximate" }
```
Phase 1 `viewports[]` keeps working as `runtime: "playwright"` so existing configs/tests don't break.

### 2. Android emulator fleet (`packages/android`)
- `pixelsentinel devices doctor` — checks KVM, Java, SDK, cmdline-tools, system images; prints exact fixes.
- `pixelsentinel devices install` — downloads `cmdline-tools`, `sdkmanager --install` platform-tools, emulator, and system images per profile (`google_apis_playstore` for phones/tablets so Chrome exists; `android-tv`, `android-wear`, `android-automotive` images for the others).
- Built-in AVD profiles (`core/src/runtime/android/profiles.ts`): Pixel 8, Pixel 8 Pro, Pixel Tablet, Pixel Fold, Galaxy-class 7" tablet, small 5" phone, Android TV 1080p + 4K, Wear OS round 1.4", Automotive 1024x768. Each: `avdmanager create avd` args, API level, RAM, skin, postures.
- **EmulatorPool**: boots AVDs headless (`-no-window -gpu swiftshader_indirect -no-boot-anim -no-audio`, `-read-only` for parallel clones), waits for `sys.boot_completed`, dismisses first-run dialogs, pre-launches Chrome once and **snapshots** so subsequent runs cold-start in seconds. Concurrency bounded by host RAM (`ram / 2.5GB`). Health check + auto-restart on hang.
- Device control via Appium UiAutomator2 (`appium` + `appium-uiautomator2-driver` as deps, started in-process on an ephemeral port):
  - rotation (`adb emu rotate` / Appium orientation), fold posture (`adb emu fold|unfold`, `cmd device_state`), D-pad / remote keys for TV, font scale & display size (accessibility settings — a valuable extra test axis), dark mode toggle, keyboard shown/hidden.
- Web loading: Chrome via intent `am start -a android.intent.action.VIEW -d <url> com.android.chrome`, then CDP connect. Target `http://localhost:PORT` from Phase 1 static/dev server is reached via `adb reverse tcp:PORT tcp:PORT`.
- **Two screenshots per state**: Playwright page screenshot (used for heuristics/correlation, same as Phase 1) and `adb exec-out screencap` (shows system UI, soft keyboard, notch cut-outs, fold hinge — fed to vision for "real device" defects like content under the status bar or hidden behind the keyboard).
- New heuristics enabled only on real devices: safe-area/notch intrusion (`env(safe-area-inset-*)` vs rects), content covered by soft keyboard when input focused, fold-hinge overlap (element rect spanning hinge zone), TV overscan margin (content inside 5% border), focus ring visibility for D-pad navigation, font-scale 1.3× overflow.

### 3. Windows desktop VM (`packages/windows-vm`)
- QEMU/KVM Windows 11 VM. We cannot ship Windows; `pixelsentinel devices windows init --iso <path>` creates the disk, provisions via an autounattend.xml + a first-boot PowerShell script (install Node, Edge/Chrome/Firefox, Playwright browsers for Firefox, run `playwright run-server --port 3100` as a scheduled task). Snapshot after provisioning; every scan restores the snapshot.
- Resolution/DPI set through the VM (`QXL`/`virtio-gpu` + a PowerShell `Set-DisplayResolution` step) so Windows scaling (125%/150%) is real, not simulated.
- `WindowsRuntime` connects via `browserType.connect("ws://vm-ip:3100/...")`. Also supports an `endpoint` config so users can point at an existing Windows machine/CI runner instead of a local VM.
- Falls back cleanly with a report warning if no VM is configured.

### 4. LLM-driven exploration (`core/src/explore`)
Goal: discover the app's *states* (pages, modals, menus, form states, error states) and capture every one on every device.

- **Agent loop** (OpenAI, tool-calling): observe → decide → act → record.
  - Observation: downscaled device screenshot + compact interactable list (from the a11y tree / DOM snapshot: `[#12] button "Add to cart" (412,880 90x40)`), current URL, visited-state summary, remaining budget.
  - Tools: `tap(id)`, `type(id, text)`, `scroll(dir)`, `swipe`, `back`, `navigate(url)`, `press_key(DPAD_*)` (TV), `rotate`, `set_posture`, `done(reason)`.
  - Guardrails: allow-list of origins, deny-list of destructive labels (delete/pay/send) unless `explore.allowDestructive`, synthetic test credentials from config, no external links, max steps / max states / max minutes, token budget cap.
- **State fingerprint** = normalized URL + hash of structural DOM (tags+classes, no text) → dedupe; the agent is told which states are already seen so it hunts for new ones.
- **Pilot-then-replay** (cost control): the agent explores once on a *pilot* device (default Pixel 8). Every state is stored with its **action trace**. On all other devices the trace is *replayed deterministically* (selector-based, with retries); the agent is only re-invoked when a replay step fails (e.g. hamburger menu exists only on mobile). Optional `explore.perDevice: true` to run the full agent on every device.
- Captures are taken at each state, through the existing Phase 1 pipeline: heuristics → vision → correlate → annotate. `Finding` gains `stateId` and `trace[]`; the report can show "how to reproduce".
- Also records runtime errors during interaction (console errors, unhandled rejections, failed requests, 4xx/5xx) as `runtime-error` findings — this is the "errors in the front end" half beyond pure visuals.

### 5. Fix proposals (`packages/fixer`)
Propose only; nothing is written into the user's tree.
- **Source mapping** (requires `target` to be a local project, as in Phase 1 `--start`):
  1. React/Vue/Svelte dev mode: read `_debugSource` / `__vueParentComponent` / `data-svelte-h` from the element in-page → exact `file:line`.
  2. Source maps from the dev server for the CSS rule/selector (via CDP `CSS.getMatchedStylesForNode` → stylesheet URL → `.map` → original file:line). Works for Tailwind/CSS modules/Sass.
  3. Fallback: grep the project for class names / text content / `data-testid` present on the element.
- **Patch generation**: LLM gets the finding (type, description, bbox, element CSS), the before screenshot crop, the mapped source excerpts (±40 lines), and the framework detected from `package.json`; must return a unified diff. Validate with `git apply --check` in a **temporary `git worktree`**; reject hallucinated paths.
- **Verification (still propose-only)**: in that throwaway worktree, apply the patch, start the dev server on a new port, replay the state's trace on the affected device, re-run heuristics + vision on that single state. Patch is labelled `verified` if the finding disappears and no new findings appear in that state, `unverified` otherwise, with before/after crops. Worktree deleted afterwards.
- Output: `pixelsentinel-output/patches/<finding-id>.diff` + `patches/index.json`; the report gets a "Proposed fixes" panel with diff viewer, before/after, and `git apply` command. `pixelsentinel fixes apply <id>` exists as an explicit opt-in command for the user.
- Groups findings sharing the same root element/rule across devices into one patch (the usual case: one bad CSS rule shows up on 6 devices).

### 6. Report, dashboard, CLI
- Report matrix becomes device × state (was viewport × single page). Device cards show fidelity badge (`real` / `webview` / `approximate`), runtime, browser, posture, orientation, font scale.
- State detail: both screenshots (page + device frame), finding list, reproduce trace, proposed patch.
- Dashboard: live device fleet panel (booting/ready/busy, adb serial, Appium port), agent step stream (SSE) with the screenshot it saw and the action it chose, cost meter (tokens, $, by phase).
- CLI:
  - `pixelsentinel devices doctor | install | list | create <profile> | windows init --iso`
  - `pixelsentinel scan <target> --devices pixel_8,pixel_fold,tv_1080p,windows:msedge --explore --max-steps 40 --propose-fixes`
  - `pixelsentinel explore <target>` (just discover states, dump traces) and `pixelsentinel replay <traces.json>`
  - `pixelsentinel fixes list | show <id> | apply <id>`
- Exit codes: configurable thresholds per fidelity (don't fail CI on `approximate` findings by default).

### 7. Optional: native/hybrid APK (if confirmed)
`AppRuntime` variant on the Android runtime: `appium:app` install, native a11y hierarchy instead of DOM snapshot, heuristics adapted to native rects (overlap, clipping, tap target), vision unchanged, correlation to resource-ids. For Capacitor/RN WebViews, CDP attach still works for the web part. Scheduled after everything above.

## Repository layout additions
```
packages/
  core/src/runtime/            # DeviceRuntime interface, playwright/, android/, windows/, webkit/
  core/src/explore/            # agent loop, tools, state fingerprint, trace record/replay
  core/src/heuristics/device/  # safe-area, keyboard, hinge, overscan, focus-ring, font-scale
  android/                     # SDK bootstrap, AVD profiles, EmulatorPool, Appium wrapper, adb helpers
  android-shell/               # Kotlin WebView shell APK (TV/Wear/Auto), prebuilt .apk committed to releases
  windows-vm/                  # QEMU lifecycle, autounattend, provisioning script, snapshot mgmt
  fixer/                       # source mapping, patch LLM, worktree verifier
fixtures/
  flows/                       # multi-page fixture app with modal, menu, form, error state (for explore tests)
  device/                      # notch-intrusion, keyboard-covers-input, hinge-overlap, overscan fixtures
```
New deps: `appium`, `appium-uiautomator2-driver`, `webdriverio`, `@devicefarmer/adbkit` (or thin `adb` exec wrapper), `simple-git`, `tar`/`yauzl` for SDK download. Playwright already present (adds `webkit` install).

## Implementation order (each step leaves `pnpm build && pnpm test` green)
1. **Runtime abstraction** — extract `PlaywrightRuntime` from `CaptureRunner`; add `WebKitRuntime`; `devices[]` config with `viewports[]` back-compat; fidelity badge in report. *Milestone: Phase 1 behaviour unchanged, iOS-approx renders appear.*
2. **Android bootstrap** — `devices doctor/install/create`, AVD profiles, EmulatorPool with snapshots, `adb reverse`, Chrome + CDP connect → `AndroidRuntime` for phones/tablets. *Milestone: `scan fixtures/overlap --devices pixel_8` produces findings from real Chrome.*
3. **Android form factors** — Appium wrapper (rotation, posture, D-pad, font scale), foldable profiles, WebView shell APK, TV/Wear/Auto profiles, device-frame screenshots, device-specific heuristics + fixtures.
4. **Exploration agent** — agent loop + tools on `DeviceSession`, state fingerprinting, trace record/replay, pilot-then-replay scheduling, runtime-error findings, `explore`/`replay` commands, cost meter. Test against `fixtures/flows` with a scripted `MockAgent` (deterministic) and a live test behind `OPENAI_API_KEY`.
5. **Fix proposals** — source mapping (framework debug info → sourcemaps → grep), patch LLM, worktree `git apply --check`, single-state verification, `patches/` output + report panel + `fixes` commands.
6. **Windows VM** — QEMU lifecycle, provisioning, `run-server` connect, resolution/DPI control, `endpoint` mode for external Windows hosts.
7. **Dashboard** — fleet panel, agent stream, device×state matrix, patch viewer.
8. **(Optional) Native APK runtime.**

## Verification
- [ ] `pnpm build && pnpm test` green; Phase 1 configs/tests unchanged.
- [ ] `pixelsentinel devices doctor` on a clean machine prints actionable steps; `devices install` + `create pixel_8` boots an AVD headless in < 90 s cold, < 15 s from snapshot.
- [ ] `scan fixtures/overlap --devices pixel_8,pixel_fold:unfolded,tv_1080p` → seeded defects found via real Chrome / WebView shell; device-frame screenshot shows status bar; hinge heuristic fires on `fixtures/device/hinge`.
- [ ] `scan fixtures/flows --explore --max-steps 30` with `MockAgent` discovers all 6 seeded states; traces replay on a second device with 0 agent re-invocations on the desktop-like device, ≥1 on mobile (hamburger menu).
- [ ] `--propose-fixes` on `fixtures/flows` (Vite + React) maps the overlap finding to the right `.css` line, emits a diff that passes `git apply --check`, and is marked `verified` after single-state re-scan; user tree `git status` is clean afterwards.
- [ ] Windows: with a provisioned VM, `--devices windows:msedge@150%` renders with real Windows scrollbars/fonts; without a VM, scan completes with a warning not a crash.
- [ ] Dashboard shows fleet status and the agent step stream for a running scan.
- [ ] CI job (GitHub Actions ubuntu with KVM, `reactivecircus/android-emulator-runner`) runs steps 1–4 tests.

## Risks / considerations
- **Host resources:** each AVD needs ~2–3 GB RAM and KVM; a Windows VM needs ~4–8 GB. Pool sizing is automatic, but a laptop will run 2–3 devices in parallel, not 11. Snapshots mitigate boot time; `-read-only` lets one AVD image back several instances.
- **Emulator flakiness:** hung boots, Chrome first-run dialogs, ANRs. Mitigated by boot timeouts, snapshot-after-setup, health checks, and per-device retry with the result marked `device-error` rather than failing the scan.
- **No real browser on TV/Wear/Auto:** WebView shell is honest but not identical to a user's actual TV browser; fidelity is surfaced as `webview`.
- **Windows licensing / ISO:** we automate the VM but cannot provide Windows; the `endpoint` mode is the escape hatch.
- **Agent cost & safety:** pilot-then-replay keeps LLM calls ~1× not N×; budgets are hard caps; destructive actions are blocked by default and origins are allow-listed.
- **Patch quality:** source mapping without framework debug info or sourcemaps degrades to grep heuristics; such patches are marked `low-confidence` and never auto-verified as `verified` unless the re-scan passes.
- **Sequential vision cost grows** with states × devices; reuse the Phase 1 image-hash cache and add per-scan `$` cap that degrades to heuristics-only when exceeded.

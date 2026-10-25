# PixelSentinel WebView shell

Kotlin Android test host for devices without Chrome. The app uses the system
WebView, with JavaScript and DOM storage enabled, no native toolbar, and WebView
remote debugging in debug builds. Reports label this runtime `webview`.

From the monorepo root, with JDK 17 available:

```bash
pnpm build
pnpm pixelsentinel devices build-shell --sdk-root .pixelsentinel/android/sdk --user-home .pixelsentinel/android/user --accept-licenses
```

This installs API 35/build-tools 35.0.0 as needed, uses the checksum-pinned Gradle
8.9 wrapper with AGP 8.7.2/Kotlin 2.1.20, runs `assembleDebug` and `lintDebug`, and
copies the APK to `dist/pixelsentinel-shell.apk`. It does not publish a release.
The main TypeScript build/test suite works without Android build dependencies.
The first Android build requires network access; Gradle caches dependencies in
the workspace's `.pixelsentinel/gradle` by default. Set `--gradle-home` to
override it. Generated files and the debug signing key are ignored by Git.
Version compatibility follows the [Android Gradle plugin 8.7 notes](https://developer.android.com/build/releases/agp-8-7-0-release-notes)
and [Kotlin Gradle compatibility table](https://kotlinlang.org/docs/gradle-configure-project.html).
The current command-line tools may emit an SDK XML-version warning with this
pinned AGP; assembly and lint were both verified with the installed packages.

The scanner installs the APK with `adb install -r` and starts
`dev.pixelsentinel.shell/.MainActivity`. The activity accepts an HTTP(S) URL in
intent data or a `url` string extra; `about:blank` is the default. Native/custom
URL schemes are blocked. Local web servers are reached with the runtime's
`adb reverse` mapping and pages are driven through Playwright's WebView CDP.

For D-pad targets the runtime adds the boolean `dpad` intent extra. A small
spatial focus fallback handles arrow keys only when the page and WebView leave
focus unchanged; custom prevented key events and editable controls retain their
normal handling. Enter/center activation follows the WebView's regular keyboard
path. The focus code has Chromium behavior tests and an opt-in real ADB test:

```bash
PIXELSENTINEL_RUN_SHELL_LIVE=1 pnpm test:android:live
```

The live test uses the connected `ps_phone` AVD to verify APK installation,
WebView capture, seeded findings, device screenshots and real D-pad key delivery.
That test does not establish TV, Wear OS or Automotive compatibility. Those
form-factor runs and release artifact publishing remain in `PHASE2-STATUS.md`.

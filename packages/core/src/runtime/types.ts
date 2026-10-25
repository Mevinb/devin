import type { Page } from "playwright";

export type RuntimeFidelity = "real" | "webview" | "approximate";

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Posture = "folded" | "unfolded" | "half-opened";

export interface AndroidTargetConfig {
  /** Base AVD booted for this target (several profiles can share one AVD via display overrides). */
  avd: string;
  /** Profile id in @pixelsentinel/android AVD_PROFILES used to create the AVD. */
  profile: string;
  /** Real Chrome, or our WebView shell APK where no browser exists (TV / Automotive). */
  browser: "chrome" | "webview-shell";
  /** Physical display override applied with `wm size` / `wm density` before rendering. */
  display?: { width: number; height: number; density: number };
  input?: "touch" | "dpad";
}

export interface WindowsTargetConfig {
  browser: "msedge" | "chrome" | "firefox";
  /** Windows display scaling factor (1, 1.25, 1.5, 2). */
  scale: number;
}

/** Per-run variations parsed from device id suffixes, e.g. `android:pixel-fold@folded@font1.3@dark`. */
export interface TargetModifiers {
  orientation?: "portrait" | "landscape";
  posture?: Posture;
  fontScale?: number;
  darkMode?: boolean;
}

export interface DeviceTarget {
  id: string; // e.g. 'android:pixel-8', 'webkit:iphone-15-pro', 'windows:msedge-1080p', 'chromium:desktop-1080p'
  name: string; // Human-readable
  runtime: "android" | "playwright" | "windows";
  fidelity: RuntimeFidelity;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  userAgent?: string;
  isMobile: boolean;
  hasTouch: boolean;
  orientation?: "portrait" | "landscape";
  // Layout constraints
  safeAreaInsets?: SafeAreaInsets;
  notchRect?: Rect;
  hingeRect?: Rect; // Foldable physical hinge
  isTV?: boolean;
  isWearable?: boolean;
  isFoldable?: boolean;
  isAutomotive?: boolean;
  engine?: "chromium" | "webkit" | "firefox";
  android?: AndroidTargetConfig;
  windows?: WindowsTargetConfig;
  modifiers?: TargetModifiers;
}

export interface DeviceControl {
  tap(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", amount?: number): Promise<void>;
  rotate(orientation: "portrait" | "landscape"): Promise<void>;
  setKeyboardVisible(visible: boolean): Promise<void>;
  back(): Promise<void>;
  /** Screenshot used by the exploration agent (device frame on real devices). */
  captureScreenshot(): Promise<Buffer>;
  /** Full device screen incl. system UI / soft keyboard / cutouts. Null when not a real device. */
  deviceScreenshot?(): Promise<Buffer | null>;
  setPosture?(posture: Posture): Promise<void>;
  setFontScale?(scale: number): Promise<void>;
  setDarkMode?(enabled: boolean): Promise<void>;
}

export interface DeviceSession {
  readonly id: string;
  readonly target: DeviceTarget;
  readonly page: Page; // Playwright Page (or CDP-backed Page for real devices)
  readonly control: DeviceControl;
  /** Non-fatal problems, e.g. "fell back to approximate Chromium because no emulator was available". */
  readonly warnings: string[];
  /** Rewrite a host URL so the device can reach it (adb reverse for localhost targets). */
  prepareUrl?(url: string): Promise<string>;
  /** Physical device identity, e.g. adb serial. */
  readonly deviceInfo?: Record<string, unknown>;
  close(): Promise<void>;
}

export interface DeviceAvailability {
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface DeviceRuntime {
  readonly name: string;
  isAvailable(target?: DeviceTarget): Promise<DeviceAvailability>;
  launch(target: DeviceTarget): Promise<DeviceSession>;
  shutdown(): Promise<void>;
}

export interface DeviceLifecycleEvent {
  targetId: string;
  name: string;
  runtime: DeviceTarget["runtime"];
  phase: "booting" | "busy" | "released" | "error";
  fidelity?: RuntimeFidelity;
  deviceInfo?: Record<string, unknown>;
  message?: string;
}

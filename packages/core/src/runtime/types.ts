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

export interface DeviceTarget {
  id: string; // e.g. 'android:pixel-8', 'webkit:iphone-15-pro', 'win:desktop-4k', 'chromium:desktop-1080p'
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
}

export interface DeviceControl {
  tap(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", amount?: number): Promise<void>;
  rotate(orientation: "portrait" | "landscape"): Promise<void>;
  setKeyboardVisible(visible: boolean): Promise<void>;
  back(): Promise<void>;
  captureScreenshot(): Promise<Buffer>;
}

export interface DeviceSession {
  readonly id: string;
  readonly target: DeviceTarget;
  readonly page: Page; // Playwright Page (or CDP-backed Page for real devices)
  readonly control: DeviceControl;
  close(): Promise<void>;
}

export interface DeviceAvailability {
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface DeviceRuntime {
  readonly name: string;
  isAvailable(): Promise<DeviceAvailability>;
  launch(target: DeviceTarget): Promise<DeviceSession>;
  shutdown(): Promise<void>;
}

import type { RenderConfig } from "../config/schema.js";
import type { DeviceTarget, TargetModifiers } from "../runtime/types.js";

export interface DOMRectJSON {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DOMElementStyles {
  zIndex: number;
  overflow: string;
  overflowX: string;
  overflowY: string;
  position: string;
  display: string;
  visibility: string;
  opacity: number;
  fontSize: string;
  lineHeight: string;
  color: string;
  backgroundColor: string;
  outlineStyle?: string;
  outlineWidth?: string;
  boxShadow?: string;
  borderWidth?: string;
}


export interface DOMElementMetrics {
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

export interface DOMElementSnapshot {
  id: string;
  selector: string;
  tagName: string;
  text: string;
  rect: DOMRectJSON;
  styles: DOMElementStyles;
  metrics: DOMElementMetrics;
  isInteractive: boolean;
  isClipped: boolean;
  parentId: string | null;
  role?: string;
  ariaModal?: boolean;
  /** Component source from framework dev builds (React _debugSource, Vue __file, Svelte __svelte_meta). */
  source?: { file: string; line: number };
}

export interface DOMSnapshot {
  document: {
    scrollWidth: number;
    scrollHeight: number;
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    /** Device width in CSS px; mobile browsers widen innerWidth to fit overflowing content. */
    screenWidth?: number;
    scrollX?: number;
    scrollY?: number;
    /** Page opted into drawing under system bars / cutouts (`<meta viewport-fit=cover>`). */
    viewportFitCover?: boolean;
    standalone?: boolean;
  };
  elements: DOMElementSnapshot[];
}

export interface FailedRequest {
  url: string;
  status?: number;
  error?: string;
}

export interface CaptureMetadata {
  renderId: string;
  viewport: RenderConfig;
  url: string;
  timestamp: string;
  consoleErrors: string[];
  failedRequests: FailedRequest[];
  hasHorizontalScroll: boolean;
  screenshotPath: string;
  /** Image bounds in document CSS coordinates, independent of device pixel ratio. */
  screenshotGeometry?: ScreenshotGeometry;
  domPath: string;
  dimensions: {
    viewportWidth: number;
    viewportHeight: number;
    pageWidth: number;
    pageHeight: number;
  };
  /** Uncaught exceptions / unhandled rejections raised by the page. */
  pageErrors?: string[];
  /** Full device screen (status bar, soft keyboard, cutouts) on real devices. */
  deviceScreenshotPath?: string;
  /** Real soft-keyboard measurements taken by focusing inputs on a real device. */
  keyboardProbes?: KeyboardProbe[];
  device?: {
    id: string;
    name: string;
    runtime: string;
    fidelity: "real" | "webview" | "approximate";
    browser?: string;
    orientation?: "portrait" | "landscape";
    modifiers?: TargetModifiers;
    info?: Record<string, unknown>;
  };
  warnings?: string[];
}

export interface ScreenshotGeometry {
  pixelWidth: number;
  pixelHeight: number;
  cssWidth: number;
  cssHeight: number;
  originX: number;
  originY: number;
  fullPage: boolean;
}

export interface KeyboardProbe {
  selector: string;
  elementId: string;
  /** Input rect bottom in viewport CSS px after focusing. */
  inputBottom: number;
  /** Bottom of the visible area (visualViewport) while the IME is shown. */
  visibleBottom: number;
  keyboardShown: boolean;
  focused?: boolean;
  attempts?: number;
  stable?: boolean;
  obscured: boolean;
  screenshotPath?: string;
}

export type CaptureRenderConfig = RenderConfig & { deviceTarget?: DeviceTarget };

export interface CaptureResult {
  renderConfig: CaptureRenderConfig;
  screenshotBuffer: Buffer;
  screenshotPath: string;
  domSnapshot: DOMSnapshot;
  domPath: string;
  metadata: CaptureMetadata;
  metaPath: string;
}

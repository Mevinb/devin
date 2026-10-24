import type { RenderConfig } from "../config/schema.js";

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
}

export interface DOMSnapshot {
  document: {
    scrollWidth: number;
    scrollHeight: number;
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
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
  domPath: string;
  dimensions: {
    viewportWidth: number;
    viewportHeight: number;
    pageWidth: number;
    pageHeight: number;
  };
}

export interface CaptureResult {
  renderConfig: RenderConfig;
  screenshotBuffer: Buffer;
  screenshotPath: string;
  domSnapshot: DOMSnapshot;
  domPath: string;
  metadata: CaptureMetadata;
  metaPath: string;
}

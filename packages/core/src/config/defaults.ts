import type { ViewportConfig } from "./schema.js";

export const DEFAULT_VIEWPORTS: ViewportConfig[] = [
  // Desktop
  {
    name: "desktop-ultrawide",
    width: 2560,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    orientation: "landscape"
  },
  {
    name: "desktop-fhd",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    orientation: "landscape"
  },
  {
    name: "desktop-laptop",
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    orientation: "landscape"
  },
  {
    name: "desktop-compact",
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    orientation: "landscape"
  },
  // Tablet (iPad)
  {
    name: "tablet-ipad-portrait",
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
    deviceDescriptor: "iPad (gen 7)"
  },
  {
    name: "tablet-ipad-landscape",
    width: 1180,
    height: 820,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    orientation: "landscape",
    deviceDescriptor: "iPad (gen 7) landscape"
  },
  // Mobile (iPhone 14)
  {
    name: "mobile-iphone14-portrait",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
    deviceDescriptor: "iPhone 14"
  },
  {
    name: "mobile-iphone14-landscape",
    width: 844,
    height: 390,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    orientation: "landscape",
    deviceDescriptor: "iPhone 14 landscape"
  },
  // Mobile (Pixel 7)
  {
    name: "mobile-pixel7-portrait",
    width: 412,
    height: 915,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait",
    deviceDescriptor: "Pixel 7"
  },
  {
    name: "mobile-pixel7-landscape",
    width: 915,
    height: 412,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    orientation: "landscape",
    deviceDescriptor: "Pixel 7 landscape"
  },
  // Small mobile
  {
    name: "mobile-small-se",
    width: 320,
    height: 568,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    orientation: "portrait"
  }
];

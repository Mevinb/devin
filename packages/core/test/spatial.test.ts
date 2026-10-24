import { describe, expect, it } from "vitest";
import { calculateIoU, calculateOverlapRatio, normalizedBBoxToCSSPixels } from "../src/correlate/spatial.js";

describe("Spatial Correlation & Geometry", () => {
  it("calculates exact IoU for identical boxes", () => {
    const box = { x: 10, y: 10, width: 100, height: 100, left: 10, top: 10, right: 110, bottom: 110 };
    const iou = calculateIoU(box, box);
    expect(iou).toBe(1);
  });

  it("calculates 0 IoU for non-overlapping boxes", () => {
    const a = { x: 0, y: 0, width: 50, height: 50, left: 0, top: 0, right: 50, bottom: 50 };
    const b = { x: 100, y: 100, width: 50, height: 50, left: 100, top: 100, right: 150, bottom: 150 };
    expect(calculateIoU(a, b)).toBe(0);
  });

  it("calculates partial overlap IoU correctly", () => {
    const a = { x: 0, y: 0, width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100 };
    const b = { x: 50, y: 0, width: 100, height: 100, left: 50, top: 0, right: 150, bottom: 100 };
    // Intersection: 50x100 = 5000. Union: 10000 + 10000 - 5000 = 15000. IoU = 5000 / 15000 = 1/3
    const iou = calculateIoU(a, b);
    expect(iou).toBeCloseTo(0.333, 2);
  });

  it("converts normalized vision bounding boxes to CSS pixels", () => {
    const norm = { ymin: 0.1, xmin: 0.2, ymax: 0.5, xmax: 0.8 };
    const css = normalizedBBoxToCSSPixels(norm, 1000, 2000);

    expect(css.left).toBe(200);
    expect(css.top).toBe(200);
    expect(css.right).toBe(800);
    expect(css.bottom).toBe(1000);
    expect(css.width).toBe(600);
    expect(css.height).toBe(800);
  });

  it("calculates containment overlap ratio", () => {
    const outer = { x: 0, y: 0, width: 200, height: 200, left: 0, top: 0, right: 200, bottom: 200 };
    const inner = { x: 50, y: 50, width: 100, height: 100, left: 50, top: 50, right: 150, bottom: 150 };

    const ratio = calculateOverlapRatio(inner, outer);
    expect(ratio).toBe(1);
  });
});

import sharp from "sharp";
import type { NormalizedBBox } from "./types.js";

export interface ImageTile {
  index: number;
  buffer: Buffer;
  offsetY: number;
  tileHeight: number;
  totalWidth: number;
  totalHeight: number;
}

export async function processAndTileScreenshot(
  imageBuffer: Buffer,
  maxDimension: number = 1568
): Promise<ImageTile[]> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1280;
  const height = metadata.height || 800;

  // If screenshot fits in standard dimension, send as single image
  if (height <= maxDimension && width <= maxDimension) {
    return [
      {
        index: 0,
        buffer: imageBuffer,
        offsetY: 0,
        tileHeight: height,
        totalWidth: width,
        totalHeight: height
      }
    ];
  }

  // If width is extremely large, downscale preserving aspect ratio
  if (width > maxDimension && height <= maxDimension) {
    const resized = await sharp(imageBuffer)
      .resize({ width: maxDimension, fit: "inside" })
      .png()
      .toBuffer();
    return [
      {
        index: 0,
        buffer: resized,
        offsetY: 0,
        tileHeight: height,
        totalWidth: width,
        totalHeight: height
      }
    ];
  }

  // Tall screenshot: slice into overlapping vertical tiles
  const tiles: ImageTile[] = [];
  const overlap = 150; // 150px vertical overlap so border defects aren't cut
  const sliceHeight = maxDimension;

  let currentY = 0;
  let tileIndex = 0;

  while (currentY < height) {
    const remainingHeight = height - currentY;
    const actualSliceHeight = Math.min(sliceHeight, remainingHeight);

    const tileBuffer = await sharp(imageBuffer)
      .extract({
        left: 0,
        top: currentY,
        width: width,
        height: actualSliceHeight
      })
      .png()
      .toBuffer();

    tiles.push({
      index: tileIndex++,
      buffer: tileBuffer,
      offsetY: currentY,
      tileHeight: actualSliceHeight,
      totalWidth: width,
      totalHeight: height
    });

    if (currentY + actualSliceHeight >= height) {
      break;
    }

    currentY += actualSliceHeight - overlap;
  }

  return tiles;
}

export function tileBBoxToFullBBox(
  tileBBox: NormalizedBBox,
  tile: ImageTile
): NormalizedBBox {
  const tilePixelTop = tileBBox.ymin * tile.tileHeight;
  const tilePixelBottom = tileBBox.ymax * tile.tileHeight;

  const fullPixelTop = tile.offsetY + tilePixelTop;
  const fullPixelBottom = tile.offsetY + tilePixelBottom;

  return {
    ymin: Math.max(0, Math.min(1, fullPixelTop / tile.totalHeight)),
    xmin: Math.max(0, Math.min(1, tileBBox.xmin)),
    ymax: Math.max(0, Math.min(1, fullPixelBottom / tile.totalHeight)),
    xmax: Math.max(0, Math.min(1, tileBBox.xmax))
  };
}

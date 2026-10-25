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
  if (!Number.isInteger(maxDimension) || maxDimension < 1) throw new Error("Maximum image dimension must be a positive integer");
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

  // Retain original-image coordinates while limiting both sent dimensions.
  const tiles: ImageTile[] = [];
  const scale = Math.min(1, maxDimension / width);
  const sliceHeight = Math.max(1, Math.floor(maxDimension / scale));
  const overlap = Math.min(Math.floor(sliceHeight / 4), Math.ceil(150 / scale));

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
      .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
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

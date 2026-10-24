import fs from "node:fs/promises";
import sharp from "sharp";
import type { Finding } from "../heuristics/types.js";

const SEVERITY_COLORS = {
  critical: { stroke: "#ef4444", fill: "rgba(239, 68, 68, 0.15)", text: "#ffffff" },
  warning: { stroke: "#f59e0b", fill: "rgba(245, 158, 11, 0.15)", text: "#ffffff" },
  info: { stroke: "#3b82f6", fill: "rgba(59, 130, 246, 0.15)", text: "#ffffff" }
};

export async function annotateScreenshot(
  imageBuffer: Buffer,
  findings: Finding[],
  outputPath?: string
): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1280;
  const height = metadata.height || 800;

  if (findings.length === 0) {
    if (outputPath) {
      await fs.writeFile(outputPath, imageBuffer);
    }
    return imageBuffer;
  }

  // Build SVG overlay
  const svgElements = findings.map((finding, idx) => {
    const num = idx + 1;
    const colors = SEVERITY_COLORS[finding.severity] || SEVERITY_COLORS.warning;
    const { x, y, width: boxWidth, height: boxHeight } = finding.bbox;

    // Badge styling
    const badgeSize = 24;
    const badgeX = Math.max(0, x);
    const badgeY = Math.max(0, y - badgeSize - 4);

    return `
      <!-- Finding #${num} Box -->
      <rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}"
            fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="3" rx="4" />
      
      <!-- Number Badge -->
      <rect x="${badgeX}" y="${badgeY}" width="${badgeSize}" height="${badgeSize}"
            fill="${colors.stroke}" rx="6" />
      <text x="${badgeX + badgeSize / 2}" y="${badgeY + badgeSize / 2 + 5}"
            font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="bold"
            fill="${colors.text}" text-anchor="middle">${num}</text>
    `;
  });

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      ${svgElements.join("\n")}
    </svg>
  `;

  const annotatedBuffer = await sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  if (outputPath) {
    await fs.writeFile(outputPath, annotatedBuffer);
  }

  return annotatedBuffer;
}

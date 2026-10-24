import type { RenderConfig, ScanConfig } from "./schema.js";
import { DEFAULT_VIEWPORTS } from "./defaults.js";

export function expandMatrix(config: ScanConfig): RenderConfig[] {
  const viewports = (config.viewports && config.viewports.length > 0)
    ? config.viewports
    : DEFAULT_VIEWPORTS;

  return viewports.map((vp) => {
    const dpr = vp.deviceScaleFactor || 1;
    const orientation = vp.orientation || (vp.width >= vp.height ? "landscape" : "portrait");
    const sanitizedName = vp.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const renderId = `${sanitizedName}_${vp.width}x${vp.height}@${dpr}x_${orientation}`;

    return {
      ...vp,
      deviceScaleFactor: dpr,
      orientation,
      renderId
    };
  });
}

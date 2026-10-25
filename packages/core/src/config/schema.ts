import { z } from "zod";
import { BudgetConfigSchema } from "../budget.js";

export const ViewportConfigSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().default(1),
  isMobile: z.boolean().default(false),
  hasTouch: z.boolean().default(false),
  orientation: z.enum(["portrait", "landscape"]).default("landscape"),
  deviceDescriptor: z.string().optional()
});

export type ViewportConfig = z.infer<typeof ViewportConfigSchema>;

export const RenderConfigSchema = ViewportConfigSchema.extend({
  renderId: z.string()
});

export type RenderConfig = z.infer<typeof RenderConfigSchema>;

export const VisionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default("gpt-4o"),
  maxImageDim: z.number().int().positive().default(1568),
  cacheDir: z.string().optional()
});

export type VisionConfig = z.infer<typeof VisionConfigSchema>;

export const OutputConfigSchema = z.object({
  dir: z.string().default("./pixelsentinel-output"),
  clean: z.boolean().default(true),
  html: z.boolean().default(true),
  json: z.boolean().default(true),
  annotatedImages: z.boolean().default(true)
});

export type OutputConfig = z.infer<typeof OutputConfigSchema>;

export const DevServerConfigSchema = z.object({
  command: z.string().optional(),
  port: z.number().int().nonnegative().optional(),
  readyTimeoutMs: z.number().int().positive().default(30000)
});

export type DevServerConfig = z.infer<typeof DevServerConfigSchema>;

export const DeviceTargetSchema = z.object({
  id: z.string(),
  name: z.string(),
  runtime: z.enum(["android", "playwright", "windows"]),
  fidelity: z.enum(["real", "webview", "approximate"]).default("approximate"),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }),
  deviceScaleFactor: z.number().positive().default(1),
  userAgent: z.string().optional(),
  isMobile: z.boolean().default(false),
  hasTouch: z.boolean().default(false),
  engine: z.enum(["chromium", "webkit", "firefox"]).optional(),
  android: z.object({
    avd: z.string(), profile: z.string(), browser: z.enum(["chrome", "webview-shell"]),
    display: z.object({ width: z.number().positive(), height: z.number().positive(), density: z.number().positive() }).optional(),
    input: z.enum(["touch", "dpad"]).optional()
  }).optional(),
  windows: z.object({ browser: z.enum(["msedge", "chrome", "firefox"]), scale: z.number().positive() }).optional(),
  modifiers: z.object({
    orientation: z.enum(["portrait", "landscape"]).optional(),
    posture: z.enum(["folded", "unfolded", "half-opened"]).optional(),
    fontScale: z.number().positive().optional(), darkMode: z.boolean().optional()
  }).optional(),
  orientation: z.enum(["portrait", "landscape"]).default("landscape").optional(),
  safeAreaInsets: z
    .object({
      top: z.number(),
      right: z.number(),
      bottom: z.number(),
      left: z.number()
    })
    .optional(),
  notchRect: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number()
    })
    .optional(),
  hingeRect: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number()
    })
    .optional(),
  isTV: z.boolean().optional(),
  isWearable: z.boolean().optional(),
  isFoldable: z.boolean().optional(),
  isAutomotive: z.boolean().optional()
});

export type DeviceConfig = z.infer<typeof DeviceTargetSchema>;

export const ScanConfigSchema = z.object({
  target: z.string().min(1, "Target URL or local directory path is required"),
  viewports: z.array(ViewportConfigSchema).optional(),
  devices: z.array(z.union([z.string(), DeviceTargetSchema])).optional(),
  browser: z.literal("chromium").default("chromium"),
  fullPage: z.boolean().default(true),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).default("networkidle"),
  extraWaitMs: z.number().int().nonnegative().default(1000),
  concurrency: z.number().int().positive().default(4),
  devServer: DevServerConfigSchema.optional(),
  budget: BudgetConfigSchema.default({}),
  vision: VisionConfigSchema.default({}),
  output: OutputConfigSchema.default({})
});

export type ScanConfig = z.infer<typeof ScanConfigSchema>;
export type ScanConfigInput = z.input<typeof ScanConfigSchema>;

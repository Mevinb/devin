import { z } from "zod";
import type { AgentAction } from "./types.js";

const description = z.string().max(2000).optional();
const target = { selector: z.string().min(1).max(2000).optional(), elementId: z.string().min(1).max(200).optional() };
const direction = z.enum(["up", "down", "left", "right"]);
const amount = z.number().finite().positive().max(10000).optional();
export const AgentActionSchema: z.ZodType<AgentAction> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), ...target, x: z.number().finite().nonnegative().optional(), y: z.number().finite().nonnegative().optional(), description }),
  z.object({ type: z.literal("type"), ...target, text: z.string().max(10000), description }),
  z.object({ type: z.literal("scroll"), direction, amount, description }),
  z.object({ type: z.literal("swipe"), direction, amount, description }),
  z.object({ type: z.literal("press_key"), key: z.string().min(1).max(80).regex(/^[\w+.-]+$/), description }),
  z.object({ type: z.literal("rotate"), orientation: z.enum(["portrait", "landscape"]), description }),
  z.object({ type: z.literal("set_posture"), posture: z.enum(["folded", "unfolded", "half-opened"]), description }),
  z.object({ type: z.literal("back"), description }),
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(8000), description }),
  z.object({ type: z.literal("done"), reason: z.string().max(2000) })
]).superRefine((action, ctx) => {
  if (action.type === "tap") {
    if ((action.x === undefined) !== (action.y === undefined) || (!action.selector && !action.elementId && action.x === undefined)) {
      ctx.addIssue({ code: "custom", message: "Tap needs a selector/elementId or a finite coordinate pair" });
    }
  }
  if (action.type === "type" && !action.selector && !action.elementId) ctx.addIssue({ code: "custom", message: "Type needs a selector/elementId" });
});

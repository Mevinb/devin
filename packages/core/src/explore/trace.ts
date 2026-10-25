import { z } from "zod";
import { DeviceTargetSchema } from "../config/schema.js";
import { AgentActionSchema } from "./action-schema.js";
import type { AgentAction, ReplayableTrace } from "./types.js";

const stateId = z.string().min(1).max(200);
const schema = z.object({
  traceId: z.string().min(1).max(200), pilotTarget: DeviceTargetSchema,
  startUrl: z.string().url().optional(), startTime: z.string(), endTime: z.string(),
  discoveredStates: z.array(z.object({ stateId, name: z.string(), fingerprint: z.string(), url: z.string().url() })).min(1).max(1000),
  steps: z.array(z.object({ stepIndex: z.number().int().nonnegative(), action: AgentActionSchema, stateBefore: stateId, stateAfter: stateId,
    timestamp: z.string(), screenshotPath: z.string().optional(), failed: z.boolean().optional(), details: z.string().optional() })).max(10000)
}).superRefine((trace, ctx) => {
  const ids = new Set(trace.discoveredStates.map((state) => state.stateId));
  if (ids.size !== trace.discoveredStates.length) ctx.addIssue({ code: "custom", message: "Trace contains duplicate state IDs" });
  for (const [index, step] of trace.steps.entries()) {
    if (step.stepIndex !== index || !ids.has(step.stateBefore) || !ids.has(step.stateAfter)) ctx.addIssue({ code: "custom", path: ["steps", index], message: "Trace step index or state reference is invalid" });
  }
});

/** Treat saved JSON as input, not as executable trusted TypeScript. */
export function parseReplayTrace(input: unknown): ReplayableTrace { return schema.parse(input); }

export function rebaseTraceUrl(value: string, trace: ReplayableTrace, startUrl: string): string {
  const originalStart = new URL(trace.startUrl ?? trace.discoveredStates[0].url);
  const original = new URL(value, originalStart);
  const next = new URL(startUrl);
  if (original.origin !== originalStart.origin || original.protocol !== originalStart.protocol) return original.href;
  if (original.pathname === originalStart.pathname) return new URL(original.search + original.hash || next.href, next).href;
  if (original.protocol === "file:") return new URL(original.pathname.slice(originalStart.pathname.lastIndexOf("/") + 1) + original.search + original.hash, next).href;
  original.protocol = next.protocol; original.host = next.host;
  return original.href;
}

export function rebaseTraceAction(action: AgentAction, trace: ReplayableTrace, startUrl: string): AgentAction {
  return action.type === "navigate" ? { ...action, url: rebaseTraceUrl(action.url, trace, startUrl) } : action;
}

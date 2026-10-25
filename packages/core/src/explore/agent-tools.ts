import type OpenAI from "openai";
import { AgentActionSchema } from "./action-schema.js";
import type { AgentAction } from "./types.js";

const directions = { type: "string", enum: ["up", "down", "left", "right"] };
const distance = { type: "number", exclusiveMinimum: 0, maximum: 10000, description: "Distance in CSS pixels" };
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): OpenAI.Chat.Completions.ChatCompletionTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

/** The advertised tools and response decoder share the executor's action vocabulary. */
export const EXPLORATION_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  tool("tap", "Tap an interactive element from the observation", { elementId: { type: "string" }, description: { type: "string" } }, ["elementId"]),
  tool("type_text", "Enter synthetic test text into an editable input", { elementId: { type: "string" }, text: { type: "string", maxLength: 10000 } }, ["elementId", "text"]),
  tool("scroll", "Scroll the viewport", { direction: directions, amount: distance }, ["direction"]),
  tool("swipe", "Swipe on a touch device", { direction: directions, amount: distance }, ["direction"]),
  tool("press_key", "Press a keyboard or D-pad key, such as Escape, Tab or DPAD_CENTER", { key: { type: "string" } }, ["key"]),
  tool("rotate", "Change device orientation when supported by this runtime", { orientation: { type: "string", enum: ["portrait", "landscape"] } }, ["orientation"]),
  tool("set_posture", "Change foldable posture; requires a supported foldable device", { posture: { type: "string", enum: ["folded", "unfolded", "half-opened"] } }, ["posture"]),
  tool("back", "Navigate back to the previous page or state", {}),
  tool("navigate", "Navigate to a URL permitted by the exploration origin policy", { url: { type: "string" } }, ["url"]),
  tool("done", "Conclude exploration when reachable states are covered", { reason: { type: "string" } }, ["reason"])
];

export function decodeAgentToolCall(name: string, argumentsJson: string): AgentAction | null {
  if (!EXPLORATION_TOOLS.some((entry) => entry.type === "function" && entry.function.name === name)) return null;
  try {
    const args: unknown = JSON.parse(argumentsJson);
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const parsed = AgentActionSchema.safeParse({ ...args, type: name === "type_text" ? "type" : name });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

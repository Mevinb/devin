import { afterEach, expect, it, vi } from "vitest";
import { EXPLORATION_TOOLS, decodeAgentToolCall } from "../src/explore/agent-tools.js";
import { ExplorationAgent } from "../src/explore/agent.js";
import type { DOMSnapshot } from "../src/capture/types.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: request } }; } }));
const snap: DOMSnapshot = { document: { innerWidth: 412, innerHeight: 915, scrollWidth: 412, scrollHeight: 915, devicePixelRatio: 1 }, elements: [] };
afterEach(() => { vi.unstubAllEnvs(); request.mockReset(); });

it("decodes every advertised device/navigation tool and rejects malformed model arguments", () => {
  const calls: Record<string, object> = {
    tap: { elementId: "el-1" }, type_text: { elementId: "el-2", text: "test@example.invalid" },
    scroll: { direction: "down" }, swipe: { direction: "left", amount: 200 }, press_key: { key: "DPAD_CENTER" },
    rotate: { orientation: "landscape" }, set_posture: { posture: "half-opened" }, back: {}, navigate: { url: "/details" }, done: { reason: "Covered" }
  };
  expect(EXPLORATION_TOOLS).toHaveLength(Object.keys(calls).length);
  for (const [name, args] of Object.entries(calls)) expect(decodeAgentToolCall(name, JSON.stringify(args))).toEqual({ ...args, type: name === "type_text" ? "type" : name });
  expect(decodeAgentToolCall("swipe", '{"direction":"diagonal"}')).toBeNull();
  expect(decodeAgentToolCall("set_posture", '{"posture":"standing"}')).toBeNull();
  expect(decodeAgentToolCall("rotate", "bad-json")).toBeNull();
  expect(decodeAgentToolCall("tap", "{}")).toBeNull();
  expect(decodeAgentToolCall("shell", '{"command":"pwd"}')).toBeNull();
});

it("sends the full tool schema to the mocked SDK and honors allowed origins during recovery", async () => {
  vi.stubEnv("OPENAI_API_KEY", "offline-sdk-test");
  const agent = new ExplorationAgent({ allowedOrigins: ["https://approved.example.invalid"] });
  const calls = [
    ["swipe", { direction: "up", amount: 300 }], ["rotate", { orientation: "landscape" }],
    ["set_posture", { posture: "folded" }], ["navigate", { url: "https://approved.example.invalid/details" }]
  ] as const;
  for (const [name, args] of calls) {
    request.mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 12 } });
    expect(await agent.decideNextAction(snap, "https://fixture.example.invalid", "home", { goal: "Details" })).toEqual({ ...args, type: name });
  }
  expect(request.mock.calls[0][0].tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(Object.keys({ tap: 1, type_text: 1, scroll: 1, swipe: 1, press_key: 1, rotate: 1, set_posture: 1, back: 1, navigate: 1, done: 1 }));
  expect(agent.llmCalls).toBe(4); expect(agent.tokensUsed).toBe(48);
});

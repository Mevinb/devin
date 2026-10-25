import { expect, it } from "vitest";
import { RunBudget } from "../src/budget.js";

const models = { test: { contextTokens: 100, inputUsdPerMillion: 2, outputUsdPerMillion: 8 } };
const receipt = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };

it("reserves across phases and concurrent calls before dispatch, then releases unused capacity", async () => {
  const budget = new RunBudget({ maxTokens: 150, models });
  let finish!: (value: { usage: typeof receipt }) => void;
  const first = budget.request("agent", "test", 10, () => new Promise<{ usage: typeof receipt }>((resolve) => { finish = resolve; }));
  expect(budget.snapshot().reservedTokens).toBe(110);
  // Remaining capacity cannot reserve a second call, even in another phase.
  let invoked = false;
  await expect(budget.request("vision", "test", 10, async () => { invoked = true; return { usage: receipt }; })).rejects.toThrow(/token budget/i);
  expect(invoked).toBe(false);
  finish({ usage: receipt }); await first;
  expect(budget.snapshot().totalTokens).toBe(25);
  expect(budget.snapshot().reservedTokens).toBe(0);
  budget.dispose();
});

it("records configured dollar estimates and reports unknown prices without inventing zero cost", async () => {
  const budget = new RunBudget({ models });
  await budget.request("agent", "test", 10, async () => ({ usage: receipt }));
  await budget.request("fixer", "unpriced", 10, async () => ({ usage: receipt }));
  budget.cacheHit("vision");
  const usage = budget.snapshot();
  expect(usage.phases.agent.costUsd).toBeCloseTo(0.00008, 9);
  expect(usage.phases.fixer.costUsd).toBeNull(); expect(usage.costUsd).toBeNull();
  expect(usage.phases.vision.cacheHits).toBe(1); expect(usage.requests).toBe(2);
  budget.dispose();
});

it("reserves dollars before a second phase can dispatch and preserves longer explicit deadlines", async () => {
  const budget = new RunBudget({ maxMinutes: 10, maxCostUsd: 0.0005, models });
  budget.constrain({ maxStates: 2 }); expect(budget.snapshot().limits.maxMinutes).toBe(10);
  let finish!: (value: { usage: typeof receipt }) => void;
  const pending = budget.request("vision", "test", 10, () => new Promise<{ usage: typeof receipt }>((resolve) => { finish = resolve; }));
  let sent = false;
  await expect(budget.request("fixer", "test", 10, async () => { sent = true; return { usage: receipt }; })).rejects.toThrow(/cost budget/i);
  expect(sent).toBe(false); finish({ usage: receipt }); await pending;
  expect(budget.snapshot()).toMatchObject({ requests: 1, reservedCostUsd: 0, stopped: { kind: "cost" } });
  budget.dispose();
});

it("rejects missing token ceilings/prices before dispatch and retains uncertain failed-request allocations", async () => {
  const unconfigured = new RunBudget({ maxCostUsd: 1 });
  await expect(unconfigured.request("vision", "unknown", 10, async () => ({ usage: receipt }))).rejects.toThrow(/model.*ceiling|model.*pricing/i);
  expect(unconfigured.snapshot().requests).toBe(0); unconfigured.dispose();
  const budget = new RunBudget({ maxTokens: 300, maxCostUsd: 1, models });
  await expect(budget.request("vision", "test", 10, async () => { throw new Error("Transport failed"); })).rejects.toThrow("Transport failed");
  expect(budget.snapshot()).toMatchObject({ requests: 1, totalTokens: 0, reservedTokens: 110, uncertainRequests: 1 });
  await budget.request("recovery", "test", 10, async () => ({}));
  expect(budget.snapshot()).toMatchObject({ requests: 2, reservedTokens: 220, uncertainRequests: 2 });
  budget.dispose();
});

it("shares action and unique-state bounds while permitting existing states on later devices", () => {
  const budget = new RunBudget({ maxActions: 2, maxStates: 2 });
  budget.claimState("home"); budget.claimState("dialog"); budget.claimState("home");
  expect(() => budget.claimState("catalog")).toThrow(/state limit/i);
  expect(budget.snapshot().states).toBe(2);
  budget.consumeAction(); budget.consumeAction();
  expect(() => budget.consumeAction()).toThrow(/action budget/i);
  expect(budget.snapshot().actions).toBe(2); budget.dispose();
});

it("aborts in-flight requests at the shared deadline and cleans up late resources", async () => {
  const budget = new RunBudget({ maxMinutes: 0.001 });
  let aborted = false;
  const request = budget.request("agent", "test", 10, ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  await expect(request).rejects.toThrow(/time budget/i); expect(aborted).toBe(true); budget.dispose();
  const second = new RunBudget({ maxMinutes: 0.0005 });
  let cleaned = false;
  await expect(second.run(() => new Promise<string>((resolve) => setTimeout(() => resolve("resource"), 60)), async () => { cleaned = true; })).rejects.toThrow(/time budget/i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(cleaned).toBe(true); second.dispose();
});

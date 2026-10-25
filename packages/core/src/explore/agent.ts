import OpenAI from "openai";
import type { DOMSnapshot } from "../capture/types.js";
import { MockExplorationAgent } from "./mock-agent.js";
import type { AgentAction, ExploreConfig } from "./types.js";
import { EXPLORATION_TOOLS, decodeAgentToolCall } from "./agent-tools.js";
import { ActionPolicy, DESTRUCTIVE_LABELS } from "./policy.js";
import { isBudgetError, RunBudget } from "../budget.js";

export interface DecideOptions {
  /** Recovery mode during replay: describe the state the agent must reach. */
  goal?: string;
  /** Recent actions, newest last. */
  history?: string[];
  isTV?: boolean;
  /** A distinct replay step can need the same menu recovery again. */
  recoveryId?: string;
}

export class ExplorationAgent {
  private openai: OpenAI | null = null;
  private mockAgent: MockExplorationAgent;
  private visitedFingerprints = new Set<string>();
  private stepCount = 0;
  private initialOrigin: string | null = null;
  /** Number of LLM requests made (cost meter). */
  llmCalls = 0;
  tokensUsed = 0;

  constructor(private readonly config: Partial<ExploreConfig> = {}, private readonly budget = new RunBudget()) {
    this.mockAgent = new MockExplorationAgent(config);
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && !config.useMockAgent) {
      this.openai = new OpenAI({ apiKey, maxRetries: 0, timeout: 30000 });
    }
  }

  get usesLLM(): boolean {
    return this.openai !== null;
  }

  private disallowed(): string[] {
    return [...DESTRUCTIVE_LABELS, ...(this.config.disallowedKeywords || [])];
  }

  /** Attach a stable selector and enforce the destructive-action deny list in code, not just the prompt. */
  private finalize(action: AgentAction, domSnapshot: DOMSnapshot): AgentAction | null {
    if ((action.type === "tap" || action.type === "type") && action.elementId && !action.selector) {
      const el = domSnapshot.elements.find((e) => e.id === action.elementId);
      if (!el) return null;
      action.selector = el.selector;
    }
    if (action.type === "tap" && !this.config.allowDestructive) {
      const el = domSnapshot.elements.find((e) => e.selector === action.selector || e.id === action.elementId);
      const text = (el?.text || "").toLowerCase();
      if (DESTRUCTIVE_LABELS.some((word) => new RegExp(`\\b${word}\\b`, "i").test(text)) ||
        this.config.disallowedKeywords?.some((word) => word && text.includes(word.toLowerCase()))) return null;
    }
    if (action.type === "navigate" && this.initialOrigin && !new ActionPolicy(this.initialOrigin, this.config).allowsUrl(action.url)) return null;
    return action;
  }

  async decideNextAction(
    domSnapshot: DOMSnapshot,
    screenshotBase64: string,
    currentUrl: string,
    currentFingerprint: string,
    options: DecideOptions = {}
  ): Promise<AgentAction> {
    this.budget.assertActive();
    const maxSteps = this.config.maxSteps || 20;
    const maxStates = this.config.maxStates || 10;

    if (!this.initialOrigin) {
      try {
        this.initialOrigin = new URL(currentUrl).origin;
      } catch {
        this.initialOrigin = null;
      }
    }

    if (!options.goal) {
      this.visitedFingerprints.add(currentFingerprint);

      if (this.stepCount >= maxSteps) {
        return { type: "done", reason: `Reached maximum step limit (${maxSteps})` };
      }

      if (this.visitedFingerprints.size >= maxStates) {
        return { type: "done", reason: `Reached maximum state limit (${maxStates})` };
      }

      this.stepCount++;
    }

    if (!this.openai) {
      return options.goal
        ? this.mockAgent.recoverToward(domSnapshot, options.goal, options.recoveryId)
        : this.mockAgent.decideNextAction(domSnapshot, currentUrl, currentFingerprint);
    }

    // Build compact element manifest of clickable/interactive elements
    const interactiveElements = domSnapshot.elements
      .filter((el) => {
        if (el.rect.width <= 0 || el.rect.height <= 0) return false;
        if (el.styles.visibility === "hidden" || el.styles.display === "none") return false;
        return el.isInteractive;
      })
      .slice(0, 40)
      .map((el) => ({
        id: el.id,
        tag: el.tagName,
        text: el.text?.slice(0, 50) || "",
        selector: el.selector,
        location: `[x:${el.rect.x}, y:${el.rect.y}, ${el.rect.width}x${el.rect.height}]`
      }));

    const disallowed = this.disallowed();

    const systemPrompt =
      this.config.systemPrompt ||
      `You are PixelSentinel's autonomous visual QA exploration agent, operating a real ${options.isTV ? "Android TV (D-pad remote: use press_key with ArrowUp/ArrowDown/ArrowLeft/ArrowRight/Enter)" : "device"}.
Your objective is to navigate the web application to uncover as many distinct visual states as possible (modals, dialogs, drawers, dropdowns, menus, forms, validation errors, tab switches, error states).

CRITICAL GUARDRAILS:
1. ${this.config.allowDestructive ? "Destructive actions were explicitly allowed for this test." : `Do NOT click destructive actions containing: ${disallowed.join(", ")}.`}
2. ${this.config.allowExternalNavigation ? "External HTTP(S) navigation was explicitly allowed." : `Stay within these allowed origins: ${[this.initialOrigin || "current host", ...(this.config.allowedOrigins ?? [])].join(", ")}.`}
3. Prioritize exploring unvisited interactive UI elements.
4. If you have explored the current view, either open another UI state (e.g. click modal/tab) or scroll to view off-screen content.
5. Use test data for forms (e.g. ${this.config.testCredentials ? JSON.stringify(this.config.testCredentials) : "test@example.com / Password123!"}).
6. If all reachable states have been explored, call done.`;

    const userPrompt = `${options.goal ? `RECOVERY GOAL: on this device the recorded step failed. Take the single action most likely to reach: ${options.goal}\n\n` : ""}Current URL: ${currentUrl}
State Fingerprint: ${currentFingerprint}
Explored States Count: ${this.visitedFingerprints.size} / ${maxStates}
Current Step: ${this.stepCount} / ${maxSteps}
Shared budget: ${JSON.stringify({ actions: this.budget.snapshot().actions, tokens: this.budget.snapshot().totalTokens, limits: this.budget.config })}
${options.history?.length ? `Recent actions:\n${options.history.slice(-6).join("\n")}\n` : ""}
Interactive Elements on screen:
${JSON.stringify(interactiveElements, null, 2)}

Select the next single action${options.goal ? " toward the goal" : " to discover new states"}.`;

    const fallback = () =>
      options.goal
        ? this.mockAgent.recoverToward(domSnapshot, options.goal, options.recoveryId)
        : this.mockAgent.decideNextAction(domSnapshot, currentUrl, currentFingerprint);

    try {
      const model = this.config.model || process.env.OPENAI_MODEL || "gpt-4o";
      const response = await this.budget.request(options.goal ? "recovery" : "agent", model, 300, (requestOptions) => {
        this.llmCalls++;
        return this.openai!.chat.completions.create({
        model,
        temperature: 0.1,
        max_tokens: 300,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${screenshotBase64}`,
                  detail: "low"
                }
              }
            ]
          }
        ],
        tools: EXPLORATION_TOOLS,
        tool_choice: "auto"
      }, requestOptions);
      });

      this.tokensUsed += response.usage?.total_tokens ?? 0;
      const message = response.choices[0]?.message;
      const call = message?.tool_calls?.[0];
      if (call && call.type === "function") {
        const action = decodeAgentToolCall(call.function.name, call.function.arguments || "{}");
        const finalized = action && this.finalize(action, domSnapshot);
        if (finalized) return finalized;
      }

      // No usable / allowed tool call
      return fallback();
    } catch (error) {
      if (isBudgetError(error)) throw error;
      // Fallback to deterministic agent on OpenAI API failure / timeout
      return fallback();
    }
  }
}

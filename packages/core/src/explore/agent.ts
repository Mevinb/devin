import OpenAI from "openai";
import type { DOMSnapshot } from "../capture/types.js";
import { MockExplorationAgent } from "./mock-agent.js";
import type { AgentAction, ExploreConfig } from "./types.js";

const DEFAULT_DISALLOWED_KEYWORDS = [
  "delete",
  "remove",
  "drop database",
  "checkout",
  "purchase",
  "buy now",
  "pay now",
  "credit card",
  "sign out",
  "logout"
];

export class ExplorationAgent {
  private openai: OpenAI | null = null;
  private mockAgent: MockExplorationAgent;
  private visitedFingerprints = new Set<string>();
  private stepCount = 0;
  private initialOrigin: string | null = null;

  constructor(private readonly config: Partial<ExploreConfig> = {}) {
    this.mockAgent = new MockExplorationAgent(config);
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async decideNextAction(
    domSnapshot: DOMSnapshot,
    screenshotBase64: string,
    currentUrl: string,
    currentFingerprint: string
  ): Promise<AgentAction> {
    const maxSteps = this.config.maxSteps || 20;
    const maxStates = this.config.maxStates || 10;

    if (!this.initialOrigin) {
      try {
        this.initialOrigin = new URL(currentUrl).origin;
      } catch {
        this.initialOrigin = null;
      }
    }

    this.visitedFingerprints.add(currentFingerprint);

    if (this.stepCount >= maxSteps) {
      return { type: "done", reason: `Reached maximum step limit (${maxSteps})` };
    }

    if (this.visitedFingerprints.size >= maxStates) {
      return { type: "done", reason: `Reached maximum state limit (${maxStates})` };
    }

    this.stepCount++;

    if (!this.openai) {
      return this.mockAgent.decideNextAction(domSnapshot, currentUrl, currentFingerprint);
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

    const disallowed = [
      ...DEFAULT_DISALLOWED_KEYWORDS,
      ...(this.config.disallowedKeywords || [])
    ];

    const systemPrompt = `You are PixelSentinel's autonomous visual QA exploration agent.
Your objective is to navigate the web application to uncover as many distinct visual states as possible (modals, dialogs, drawers, dropdowns, forms, tab switches, error states).

CRITICAL GUARDRAILS:
1. Do NOT click destructive actions containing: ${disallowed.join(", ")}.
2. Stay within origin: ${this.initialOrigin || "current host"}.
3. Prioritize exploring unvisited interactive UI elements.
4. If you have explored the current view, either open another UI state (e.g. click modal/tab) or scroll to view off-screen content.
5. If all reachable states have been explored, call done.`;

    const userPrompt = `Current URL: ${currentUrl}
State Fingerprint: ${currentFingerprint}
Explored States Count: ${this.visitedFingerprints.size} / ${maxStates}
Current Step: ${this.stepCount} / ${maxSteps}

Interactive Elements on screen:
${JSON.stringify(interactiveElements, null, 2)}

Select the next single action to discover new states.`;

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "tap",
          description: "Tap or click on an interactive element by its ID or coordinate",
          parameters: {
            type: "object",
            properties: {
              elementId: { type: "string", description: "The element id (e.g. 'el-4')" },
              description: { type: "string", description: "Why you chose this element" }
            },
            required: ["elementId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "type_text",
          description: "Enter text into an input or textarea element",
          parameters: {
            type: "object",
            properties: {
              elementId: { type: "string", description: "The input element id" },
              text: { type: "string", description: "The text to type" }
            },
            required: ["elementId", "text"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "scroll",
          description: "Scroll the viewport in a direction",
          parameters: {
            type: "object",
            properties: {
              direction: { type: "string", enum: ["up", "down", "left", "right"] },
              amount: { type: "number", description: "Pixels to scroll, e.g. 400" }
            },
            required: ["direction"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "press_key",
          description: "Press a keyboard key (e.g. 'Escape', 'Enter', 'Tab')",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string" }
            },
            required: ["key"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "back",
          description: "Navigate back to the previous page or state",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "done",
          description: "Conclude the exploration when all reachable states are covered",
          parameters: {
            type: "object",
            properties: {
              reason: { type: "string" }
            },
            required: ["reason"]
          }
        }
      }
    ];

    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
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
        tools,
        tool_choice: "auto"
      });

      const message = response.choices[0]?.message;
      if (message?.tool_calls && message.tool_calls.length > 0) {
        const call = message.tool_calls[0];
        const args = JSON.parse(call.function.arguments || "{}");

        switch (call.function.name) {
          case "tap":
            return {
              type: "tap",
              elementId: args.elementId,
              description: args.description || "LLM tapped element"
            };
          case "type_text":
            return {
              type: "type",
              elementId: args.elementId,
              text: args.text || "test"
            };
          case "scroll":
            return {
              type: "scroll",
              direction: args.direction || "down",
              amount: args.amount || 400
            };
          case "press_key":
            return {
              type: "press_key",
              key: args.key || "Escape"
            };
          case "back":
            return { type: "back" };
          case "done":
            return { type: "done", reason: args.reason || "Exploration complete" };
        }
      }

      // Fallback if no tool was called
      return this.mockAgent.decideNextAction(domSnapshot, currentUrl, currentFingerprint);
    } catch {
      // Fallback to mock agent on OpenAI API failure / timeout
      return this.mockAgent.decideNextAction(domSnapshot, currentUrl, currentFingerprint);
    }
  }
}

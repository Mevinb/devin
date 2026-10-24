import type { DOMSnapshot } from "../capture/types.js";
import type { AgentAction, ExploreConfig } from "./types.js";

export class MockExplorationAgent {
  private visitedElementIds = new Set<string>();
  private visitedFingerprints = new Set<string>();
  private stepCount = 0;

  constructor(private readonly config: Partial<ExploreConfig> = {}) {}

  async decideNextAction(
    domSnapshot: DOMSnapshot,
    currentUrl: string,
    currentFingerprint: string
  ): Promise<AgentAction> {
    const maxSteps = this.config.maxSteps || 10;
    const maxStates = this.config.maxStates || 5;

    this.visitedFingerprints.add(currentFingerprint);

    if (this.stepCount >= maxSteps) {
      return { type: "done", reason: `Reached maximum step limit (${maxSteps})` };
    }

    if (this.visitedFingerprints.size >= maxStates) {
      return { type: "done", reason: `Discovered target number of states (${maxStates})` };
    }

    this.stepCount++;

    // Find interactive elements that haven't been clicked yet
    const interactive = domSnapshot.elements.filter((el) => {
      if (this.visitedElementIds.has(el.id)) return false;
      if (el.rect.width <= 0 || el.rect.height <= 0) return false;
      if (el.styles.visibility === "hidden" || el.styles.display === "none") return false;

      // Avoid destructive keywords
      const textLower = (el.text || "").toLowerCase();
      const forbidden = ["delete", "remove", "logout", "sign out", "destroy", "cancel subscription"];
      if (forbidden.some((f) => textLower.includes(f))) return false;

      return el.isInteractive;
    });

    if (interactive.length === 0) {
      // If no new unvisited interactive elements, try scrolling down once
      if (this.stepCount === 1) {
        return { type: "scroll", direction: "down", amount: 400 };
      }
      return { type: "done", reason: "All reachable interactive elements explored" };
    }

    const targetElement = interactive[0];
    this.visitedElementIds.add(targetElement.id);

    const tag = targetElement.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      return {
        type: "type",
        elementId: targetElement.id,
        selector: targetElement.selector,
        text: "PixelSentinel Test Input"
      };
    }

    return {
      type: "tap",
      elementId: targetElement.id,
      selector: targetElement.selector,
      description: `Tap <${targetElement.tagName}> "${targetElement.text?.slice(0, 30) || targetElement.selector}"`
    };
  }
}

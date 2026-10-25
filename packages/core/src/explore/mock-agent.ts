import type { DOMElementSnapshot, DOMSnapshot } from "../capture/types.js";
import type { AgentAction, ExploreConfig } from "./types.js";
import { isDialogContainer } from "./fingerprint.js";
import { DESTRUCTIVE_LABELS } from "./policy.js";

const MENU_HINT = /(menu|hamburger|nav-?toggle|navbar-toggler|burger|drawer|☰|≡|more)/i;

function isUsable(el: DOMElementSnapshot): boolean {
  return (
    el.isInteractive &&
    el.rect.width > 0 &&
    el.rect.height > 0 &&
    el.styles.visibility !== "hidden" &&
    el.styles.display !== "none"
  );
}

/**
 * Deterministic, offline exploration agent. Used in tests, without an OpenAI key, and as the
 * fallback when the LLM returns nothing usable.
 */
export class MockExplorationAgent {
  private visitedActions = new Set<string>();
  private visitedFingerprints = new Set<string>();
  private stepCount = 0;
  private scrolled = false;
  private recoveryTried = new Map<string, Set<string>>();

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
    const byId = new Map(domSnapshot.elements.map((element) => [element.id, element]));
    const priority = (element: DOMElementSnapshot) => {
      let navigation = false;
      for (let node: DOMElementSnapshot | undefined = element; node; node = node.parentId ? byId.get(node.parentId) : undefined) {
        if (isDialogContainer(node)) return 0;
        if (["nav", "header"].includes(node.tagName)) navigation = true;
      }
      return navigation ? 2 : 1;
    };
    const modalOpen = domSnapshot.elements.some(isDialogContainer);

    const interactive = domSnapshot.elements.filter((el) => {
      if (this.visitedActions.has(`${currentFingerprint}|${el.selector}`) || !isUsable(el)) return false;
      if (modalOpen && priority(el) !== 0) return false;
      if (el.tagName === "a" && /^https?:/.test(el.text)) return false;
      const textLower = (el.text || "").toLowerCase();
      return this.config.allowDestructive === true || !(DESTRUCTIVE_LABELS.some((word) => new RegExp(`\\b${word}\\b`, "i").test(textLower)) ||
        (this.config.disallowedKeywords ?? []).some((word) => word && textLower.includes(word.toLowerCase())));
    }).sort((a, b) => priority(a) - priority(b));

    if (interactive.length === 0) {
      const scrollable = domSnapshot.document.scrollHeight > domSnapshot.document.innerHeight + 50;
      if (!this.scrolled && scrollable) {
        this.scrolled = true;
        return { type: "scroll", direction: "down", amount: 400 };
      }
      return { type: "done", reason: "All reachable interactive elements explored" };
    }

    const targetElement = interactive[0];
    this.visitedActions.add(`${currentFingerprint}|${targetElement.selector}`);

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

  /**
   * Replay recovery without an LLM: the recorded element isn't reachable on this device (typically
   * hidden behind a collapsed mobile menu), so open whatever looks like a menu toggle.
   */
  recoverToward(domSnapshot: DOMSnapshot, goal: string, recoveryId = goal): AgentAction {
    const tried = this.recoveryTried.get(recoveryId) ?? new Set<string>();
    this.recoveryTried.set(recoveryId, tried);
    const goalWords = goal.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    const usable = domSnapshot.elements.filter(isUsable);
    const textMatch = usable.find((el) => {
      const t = `${el.text} ${el.selector}`.toLowerCase();
      return goalWords.some((w) => t.includes(w)) && !tried.has(el.selector);
    });
    const menu = usable.find((el) => MENU_HINT.test(`${el.selector} ${el.text}`) && !tried.has(el.selector));
    const pick = menu ?? textMatch;
    if (!pick) return { type: "done", reason: `No route found toward ${goal}` };
    tried.add(pick.selector);
    return {
      type: "tap",
      elementId: pick.id,
      selector: pick.selector,
      description: `Recovery: open "${pick.text?.slice(0, 30) || pick.selector}" to reach ${goal}`
    };
  }
}

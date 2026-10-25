import { expect, it } from "vitest";
import type { DOMElementSnapshot, DOMSnapshot } from "../src/capture/types.js";
import { MockExplorationAgent } from "../src/explore/mock-agent.js";
import { computeStateFingerprint } from "../src/explore/fingerprint.js";

const element = (id: string, tagName: string, text: string, parentId: string | null = null): DOMElementSnapshot => ({ id, selector: `#${id}`, tagName, text, parentId,
  isInteractive: ["button", "input"].includes(tagName), isClipped: false,
  rect: { x: 0, y: 0, width: 100, height: 40, left: 0, top: 0, right: 100, bottom: 40 },
  styles: { zIndex: 0, position: "static", display: "block", visibility: "visible", opacity: 1, overflow: "visible", overflowX: "visible", overflowY: "visible",
    fontSize: "16px", lineHeight: "20px", color: "black", backgroundColor: "white" },
  metrics: { scrollWidth: 100, scrollHeight: 40, clientWidth: 100, clientHeight: 40 } });
const snapshot = (elements: DOMElementSnapshot[]): DOMSnapshot => ({ elements,
  document: { innerWidth: 1280, innerHeight: 800, scrollWidth: 1280, scrollHeight: 800, devicePixelRatio: 1 } });

it("prioritizes the open dialog and page content over global navigation", async () => {
  const nav = element("navigation", "nav", ""), dialog = { ...element("overlay", "div", ""), role: "dialog", ariaModal: true };
  const snap = snapshot([nav, element("navNext", "button", "Next", nav.id), element("mainAction", "button", "Try preview"), dialog, element("close", "button", "Close preview", dialog.id)]);
  const agent = new MockExplorationAgent();
  expect(await agent.decideNextAction(snap, "http://fixture.invalid", "dialog")).toMatchObject({ type: "tap", selector: "#close" });
  expect(await agent.decideNextAction(snapshot(snap.elements.filter((item) => !["overlay", "close"].includes(item.id))), "http://fixture.invalid", "home")).toMatchObject({ type: "tap", selector: "#mainAction" });
});
it("can reuse a stable Next control after it leads to a new structural state", async () => {
  const agent = new MockExplorationAgent(), snap = snapshot([element("next", "button", "Next")]);
  expect((await agent.decideNextAction(snap, "http://fixture.invalid", "first")).type).toBe("tap");
  expect((await agent.decideNextAction(snap, "http://fixture.invalid", "second")).type).toBe("tap");
});
it("allows reopening a menu for a later replay step with the same recovery goal", () => {
  const agent = new MockExplorationAgent(), snap = snapshot([element("menuToggle", "button", "Menu")]);
  expect(agent.recoverToward(snap, "reach Home", "step-one").type).toBe("tap");
  expect(agent.recoverToward(snap, "reach Home", "step-one").type).toBe("done");
  expect(agent.recoverToward(snap, "reach Home", "step-five").type).toBe("tap");
});
it("does not name a high-z-index banner or navigation menu as a modal", () => {
  const banner = element("banner", "div", "Sale"); banner.styles.zIndex = 100;
  const heading = element("heading", "h1", "Home");
  expect(computeStateFingerprint(snapshot([banner, heading]), "http://fixture.invalid").name).toBe("Home");
  const dialog = { ...element("overlay", "div", ""), role: "dialog", ariaModal: true };
  expect(computeStateFingerprint(snapshot([banner, heading, dialog, element("dialogTitle", "h1", "Preview", dialog.id)]), "http://fixture.invalid").name).toBe("Modal: Preview");
});

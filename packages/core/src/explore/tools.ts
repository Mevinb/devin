import type { DOMSnapshot } from "../capture/types.js";
import type { DeviceSession } from "../runtime/types.js";
import type { AgentAction } from "./types.js";
import { AgentActionSchema } from "./action-schema.js";
import { ActionPolicy } from "./policy.js";
import type { Page } from "playwright";

const policies = new WeakMap<Page, ActionPolicy>();
export interface ActionResult { success: boolean; details?: string; blocked?: boolean; }

/**
 * Resolve an element to a *viewport* point. Selectors are preferred because `el-N` ids are per-snapshot
 * counters and differ between devices. The element is scrolled into view first so taps never land
 * outside the viewport.
 */
async function resolvePoint(
  session: DeviceSession,
  selector: string | undefined,
  elementId: string | undefined,
  domSnapshot: DOMSnapshot
): Promise<{ x: number; y: number } | null> {
  const sel = selector ?? domSnapshot.elements.find((e) => e.id === elementId)?.selector;
  if (!sel) return null;
  try {
    const loc = session.page.locator(sel).first();
    if ((await loc.count()) === 0) return null;
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
    const box = await loc.boundingBox();
    if (!box || box.width === 0 || box.height === 0) return null;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  } catch {
    return null;
  }
}

async function performAction(
  session: DeviceSession,
  action: AgentAction,
  domSnapshot: DOMSnapshot,
  policy?: ActionPolicy
): Promise<ActionResult> {
  const { page, control } = session;
  const settle = async (ms: number) => {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(ms);
  };

  switch (action.type) {
    case "tap": {
      const point =
        action.x !== undefined && action.y !== undefined
          ? { x: action.x, y: action.y }
          : await resolvePoint(session, action.selector, action.elementId, domSnapshot);
      if (!point) {
        return { success: false, details: `Element not found for tap: ${action.selector || action.elementId}` };
      }
      const denied = await policy?.check(page, action, domSnapshot, point);
      if (denied) return { success: false, blocked: true, details: denied };
      await control.tap(point.x, point.y);
      await settle(700);
      return { success: true, details: `Tapped at (${Math.round(point.x)}, ${Math.round(point.y)})` };
    }

    case "type": {
      const point = await resolvePoint(session, action.selector, action.elementId, domSnapshot);
      if (!point) {
        return { success: false, details: `Input not found: ${action.selector || action.elementId}` };
      }
      const denied = await policy?.check(page, action, domSnapshot, point);
      if (denied) return { success: false, blocked: true, details: denied };
      await control.tap(point.x, point.y);
      await page.waitForTimeout(300);
      await control.typeText(action.text);
      await control.setKeyboardVisible(false).catch(() => {});
      await settle(400);
      return { success: true, details: `Typed "${action.text}"` };
    }

    case "scroll":
    case "swipe": {
      await control.scroll(action.direction, action.amount || 350);
      await settle(500);
      return { success: true, details: `Scrolled ${action.direction} by ${action.amount || 350}px` };
    }

    case "press_key": {
      await control.pressKey(action.key);
      await settle(400);
      return { success: true, details: `Pressed key ${action.key}` };
    }

    case "rotate": {
      await control.rotate(action.orientation);
      await settle(800);
      return { success: true, details: `Rotated device to ${action.orientation}` };
    }

    case "set_posture": {
      if (!control.setPosture) return { success: false, details: "This runtime does not support posture changes" };
      await control.setPosture(action.posture);
      await settle(800);
      return { success: true, details: `Set posture ${action.posture}` };
    }

    case "back": {
      await control.back();
      await settle(600);
      return { success: true, details: "Navigated back" };
    }

    case "navigate": {
      const url = session.prepareUrl ? await session.prepareUrl(action.url) : action.url;
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await settle(500);
      return { success: true, details: `Navigated to ${action.url}` };
    }

    case "done": {
      return { success: true, details: `Exploration concluded: ${action.reason}` };
    }
  }
}

/** All action sources (including saved traces and offline recovery) pass this boundary. */
export async function executeAction(session: DeviceSession, input: AgentAction, snapshot: DOMSnapshot, explicitPolicy?: ActionPolicy): Promise<ActionResult> {
  const parsed = AgentActionSchema.safeParse(input);
  if (!parsed.success) return { success: false, blocked: true, details: `Invalid action: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` };
  let action = parsed.data;
  try { if (action.type === "navigate") action = { ...action, url: new URL(action.url, session.page.url()).href }; }
  catch { return { success: false, blocked: true, details: "Invalid navigation URL" }; }
  if (action.type === "done") return performAction(session, action, snapshot);
  let policy = explicitPolicy ?? policies.get(session.page);
  if (!policy) { policy = new ActionPolicy(session.page.url()); policies.set(session.page, policy); }
  try {
    await policy.attach(session.page);
    const denied = await policy.check(session.page, action, snapshot);
    if (denied) return { success: false, blocked: true, details: denied };
    const before = policy.violations.length;
    const beforeUrl = session.page.url();
    let result: ActionResult;
    try { result = await performAction(session, action, snapshot, policy); }
    catch (error) { result = { success: false, details: (error as Error).message.split("\n")[0] }; }
    if (policy.violations.length > before) {
      // Chromium can replace an aborted navigation with its internal error document.
      if (!policy.allowsUrl(session.page.url())) await session.page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      return { success: false, blocked: true, details: policy.violations.at(-1) };
    }
    return result;
  } catch (error) {
    return { success: false, details: (error as Error).message.split("\n")[0] };
  }
}

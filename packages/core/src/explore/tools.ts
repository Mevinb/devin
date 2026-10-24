import type { DOMSnapshot } from "../capture/types.js";
import type { DeviceSession } from "../runtime/types.js";
import type { AgentAction } from "./types.js";

export async function executeAction(
  session: DeviceSession,
  action: AgentAction,
  domSnapshot: DOMSnapshot
): Promise<{ success: boolean; details?: string }> {
  const { page, control } = session;

  switch (action.type) {
    case "tap": {
      let targetX = action.x;
      let targetY = action.y;

      if ((targetX === undefined || targetY === undefined) && action.elementId) {
        const el = domSnapshot.elements.find((e) => e.id === action.elementId);
        if (el) {
          targetX = el.rect.x + el.rect.width / 2;
          targetY = el.rect.y + el.rect.height / 2;
        }
      }

      if ((targetX === undefined || targetY === undefined) && action.selector) {
        try {
          const loc = page.locator(action.selector).first();
          const box = await loc.boundingBox();
          if (box) {
            targetX = box.x + box.width / 2;
            targetY = box.y + box.height / 2;
          }
        } catch {
          // ignore
        }
      }

      if (targetX !== undefined && targetY !== undefined) {
        await control.tap(targetX, targetY);
        await page.waitForTimeout(600);
        return { success: true, details: `Tapped at (${Math.round(targetX)}, ${Math.round(targetY)})` };
      }

      return { success: false, details: `Element not found for tap action: ${action.elementId || action.selector}` };
    }

    case "type": {
      let focused = false;
      if (action.elementId) {
        const el = domSnapshot.elements.find((e) => e.id === action.elementId);
        if (el) {
          const x = el.rect.x + el.rect.width / 2;
          const y = el.rect.y + el.rect.height / 2;
          await control.tap(x, y);
          focused = true;
        }
      }

      if (!focused && action.selector) {
        try {
          await page.click(action.selector);
          focused = true;
        } catch {
          // ignore
        }
      }

      await control.typeText(action.text);
      await page.waitForTimeout(400);
      return { success: true, details: `Typed "${action.text}"` };
    }

    case "scroll": {
      await control.scroll(action.direction, action.amount || 350);
      await page.waitForTimeout(500);
      return { success: true, details: `Scrolled ${action.direction} by ${action.amount || 350}px` };
    }

    case "swipe": {
      await control.scroll(action.direction, action.amount || 350);
      await page.waitForTimeout(500);
      return { success: true, details: `Swiped ${action.direction}` };
    }

    case "press_key": {
      await control.pressKey(action.key);
      await page.waitForTimeout(400);
      return { success: true, details: `Pressed key ${action.key}` };
    }

    case "rotate": {
      await control.rotate(action.orientation);
      await page.waitForTimeout(800);
      return { success: true, details: `Rotated device to ${action.orientation}` };
    }

    case "back": {
      await control.back();
      await page.waitForTimeout(600);
      return { success: true, details: "Navigated back" };
    }

    case "navigate": {
      await page.goto(action.url, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForTimeout(500);
      return { success: true, details: `Navigated to ${action.url}` };
    }

    case "done": {
      return { success: true, details: `Exploration concluded: ${action.reason}` };
    }
  }
}

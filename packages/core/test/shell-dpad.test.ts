import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";

const script = path.resolve(__dirname, "../../android-shell/app/src/main/assets/dpad.js");
describe("WebView shell spatial focus fallback", () => {
  it("moves to visible controls in the requested direction and activates through normal keyboard events", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`<style>button{position:absolute;width:120px;height:50px}#first{left:20px;top:20px}#right{left:170px;top:20px}#below{left:20px;top:120px}#hidden{left:150px;top:20px;visibility:hidden}</style>
        <button id="first">First</button><button id="hidden">Hidden</button><button id="right" onclick="this.dataset.clicked='yes'">Right</button><button id="below">Below</button>`);
      await page.evaluate(await fs.readFile(script, "utf8"));
      await page.locator("#first").focus(); await page.keyboard.press("ArrowRight");
      await vi.waitFor(async () => expect(await page.evaluate(() => document.activeElement?.id)).toBe("right"));
      await page.keyboard.press("Enter"); expect(await page.locator("#right").getAttribute("data-clicked")).toBe("yes");
      await page.locator("#first").focus(); await page.keyboard.press("ArrowDown");
      await vi.waitFor(async () => expect(await page.evaluate(() => document.activeElement?.id)).toBe("below"));
    } finally { await browser.close(); }
  });
  it("preserves a page's prevented/custom navigation and caret keys in editable fields", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<button id="first">First</button><button id="second">Second</button><input id="edit" value="abc"><button id="last">Last</button>');
      await page.evaluate(await fs.readFile(script, "utf8"));
      // The page registers after shell injection too; its prevention must still win.
      await page.evaluate(() => document.addEventListener("keydown", (event) => event.preventDefault(), { once: true }));
      await page.locator("#first").focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(50);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("first");
      await page.locator("#edit").focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(50);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("edit");
      await page.evaluate(() => document.addEventListener("keydown", () => document.querySelector<HTMLButtonElement>("#last")!.focus(), { once: true }));
      await page.locator("#first").focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(50);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("last");
    } finally { await browser.close(); }
  });
});

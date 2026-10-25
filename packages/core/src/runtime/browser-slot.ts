import type { Browser } from "playwright";

/** Own one browser, including a launch that finishes after shutdown. */
export class BrowserSlot {
  private browser?: Browser;
  private pending?: Promise<Browser>;
  private generation = 0;

  async get(launch: () => Promise<Browser>): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = launch().then(async (browser) => {
      if (generation !== this.generation) {
        await browser.close().catch(() => {});
        throw new Error("Browser owner shut down during launch");
      }
      this.browser = browser; return browser;
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending; return pending;
  }
  async close(): Promise<void> {
    this.generation++;
    const browser = this.browser;
    this.browser = undefined; this.pending = undefined;
    // A pending launch retains its generation check and closes its late result.
    await browser?.close().catch(() => {});
  }
}

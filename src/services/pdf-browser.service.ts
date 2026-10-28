import puppeteer, { Browser, BrowserContext } from 'puppeteer';

/**
 * Reuse Chromium across nearby PDF requests while isolating every render in
 * its own browser context. The idle timeout closes Chromium after bursts so
 * the invoice service does not keep a browser process forever when idle.
 */
export class PdfBrowserService {
  private browserPromise: Promise<Browser> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeContexts = 0;

  async createContext(): Promise<BrowserContext> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;

    let browser = await this.getBrowser();
    let context: BrowserContext;
    try {
      context = await browser.createBrowserContext();
    } catch (error) {
      if (browser.connected) throw error;
      if (this.browserPromise) this.browserPromise = null;
      browser = await this.getBrowser();
      context = await browser.createBrowserContext();
    }
    this.activeContexts += 1;
    return context;
  }

  async releaseContext(context: BrowserContext): Promise<void> {
    try {
      await context.close();
    } finally {
      this.activeContexts = Math.max(0, this.activeContexts - 1);
      if (this.activeContexts === 0) this.scheduleIdleClose();
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const launching = puppeteer.launch({
        headless: true,
        executablePath: puppeteer.executablePath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      this.browserPromise = launching;
      launching.then((browser) => {
        browser.once('disconnected', () => {
          if (this.browserPromise === launching) this.browserPromise = null;
        });
      }).catch(() => {
        if (this.browserPromise === launching) this.browserPromise = null;
      });
    }

    const browser = await this.browserPromise;
    if (browser.connected) return browser;
    this.browserPromise = null;
    return this.getBrowser();
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = null;
      if (this.activeContexts !== 0 || !this.browserPromise) return;
      const closing = this.browserPromise;
      try {
        const browser = await closing;
        if (this.activeContexts === 0 && this.browserPromise === closing) {
          this.browserPromise = null;
          await browser.close();
        }
      } catch {
        if (this.browserPromise === closing) this.browserPromise = null;
      }
    }, 10_000);
  }
}

export default new PdfBrowserService();

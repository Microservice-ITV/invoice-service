const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const INVOICE_NUMBER = process.env.T_INV;
const token = jwt.sign(
  {
    scope: 'invoice:print',
    sub: process.env.T_CUST,
    invoiceId: process.env.T_ID,
    invoiceNumber: INVOICE_NUMBER,
    role: 'customer',
  },
  process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: 120 },
);

const url =
  `${process.env.FRONTEND_BASE_URL}/account/invoices/` +
  `${encodeURIComponent(INVOICE_NUMBER)}/print?token=${encodeURIComponent(token)}`;

(async () => {
  const out = [`print URL: ${url.replace(/token=[^&]+/, 'token=<redacted>')}`];
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: puppeteer.executablePath(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => out.push(`[console:${m.type()}] ${m.text().slice(0, 300)}`));
    page.on('pageerror', (e) => out.push(`[pageerror] ${String(e).slice(0, 300)}`));
    page.on('requestfailed', (r) =>
      out.push(`[reqfail] ${r.url().slice(0, 140)} :: ${r.failure()?.errorText}`),
    );

    await page.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 1 });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    out.push(`print route HTTP: ${response && response.status()}`);

    // Give the SPA time to run its data fetch, then inspect state directly.
    await new Promise((r) => setTimeout(r, 12000));

    const state = await page.evaluate(
      '({ ready: window.__INVOICE_READY__, err: window.__INVOICE_ERROR__, loc: window.location.pathname, text: document.body.innerText.replace(/\\s+/g," ").trim().slice(0,400) })',
    );
    out.push(`window.location.pathname: ${String(state.loc)}`);
    out.push(`__INVOICE_READY__: ${state.ready}`);
    out.push(`__INVOICE_ERROR__: ${state.err || '(none)'}`);
    out.push('');
    out.push('--- print route body text ---');
    out.push(String(state.text));

    await page.screenshot({ path: '/var/www/html/invoice-service/print-shot.png', fullPage: true });
    out.push('');
    out.push('screenshot written');
  } catch (e) {
    out.push(`ERROR: ${e && e.message}`);
  } finally {
    await browser.close();
  }
  fs.writeFileSync('/var/www/html/invoice-service/print-report.txt', out.join('\n'));
})();
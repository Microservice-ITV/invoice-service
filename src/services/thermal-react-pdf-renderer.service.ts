import { createHash } from 'node:crypto';
import pdfBrowserService from '@/services/pdf-browser.service';

export type ThermalPaperWidth = '58mm' | '80mm';
export const THERMAL_RENDER_CACHE_VERSION = 'thermal-layout-v10';
const THERMAL_PDF_CACHE_TTL_MS = 3 * 60 * 1000;
const THERMAL_PDF_CACHE_MAX_ENTRIES = 40;
export interface ThermalRenderDiagnostics {
  document: { scrollHeight: number; clientHeight: number };
  body: { scrollHeight: number; clientHeight: number; minHeight: string; height: string };
  root: {
    top: number; left: number; width: number; height: number; scrollHeight: number;
    position: string; overflow: string; minHeight: string; heightStyle: string;
  };
  contentBounds: { top: number; left: number; right: number; bottom: number; height: number };
  contentText: string;
  pageBreakAvoidCount: number;
}

export interface ThermalRenderResult {
  buffer: Buffer;
  diagnostics: ThermalRenderDiagnostics;
}

/** Use the rendered document's painted descendants, never the viewport or app wrapper. */
export const getThermalContentHeightPx = (bounds: ThermalRenderDiagnostics['contentBounds']): number =>
  Math.max(1, Math.ceil(bounds.bottom - Math.min(0, bounds.top)));

export const getThermalPdfOptions = (width: ThermalPaperWidth, contentHeightPx: number) => ({
  width,
  height: `${(Math.max(1, Math.ceil(contentHeightPx)) * 25.4 / 96).toFixed(2)}mm`,
  printBackground: true,
  preferCSSPageSize: false,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
});

/** Ask PDF viewers to fit the narrow thermal page to the available window width.
 * This changes only the document's initial view; page dimensions and print scale
 * stay unchanged for the selected 58mm/80mm roll.
 */
export const setThermalPdfInitialFitToWidth = (pdf: Buffer): Buffer => {
  const source = pdf.toString('latin1');
  const objectPattern = /(^|[\r\n])(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g;
  const objects = [...source.matchAll(objectPattern)];
  const catalog = objects.find((object) => /\/Type\s*\/Catalog\b/.test(object[4]));
  const firstPage = objects.find((object) => /\/Type\s*\/Page\b/.test(object[4]));
  const xrefMarkers = [...source.matchAll(/startxref\s+(\d+)/g)];
  const previousXref = xrefMarkers[xrefMarkers.length - 1]?.[1];
  if (!catalog || !firstPage || !previousXref) {
    throw new Error('Unable to set initial view on the generated thermal PDF');
  }

  const catalogId = Number(catalog[2]);
  const catalogGeneration = Number(catalog[3]);
  const pageId = Number(firstPage[2]);
  const pageGeneration = Number(firstPage[3]);
  const body = catalog[4];
  const openActionPattern = /\/OpenAction\s+(?:\[[^\]]*\]|\d+\s+\d+\s+R)/;
  const withoutOpenAction = body.replace(openActionPattern, '');
  const closingDictionary = withoutOpenAction.lastIndexOf('>>');
  if (closingDictionary < 0) throw new Error('Generated thermal PDF catalog is malformed');
  const updatedBody = `${withoutOpenAction.slice(0, closingDictionary)} /OpenAction [${pageId} ${pageGeneration} R /FitH null] ${withoutOpenAction.slice(closingDictionary)}`;

  const separator = source.endsWith('\n') || source.endsWith('\r') ? '' : '\n';
  const objectOffset = Buffer.byteLength(source + separator, 'latin1');
  const objectText = `${catalogId} ${catalogGeneration} obj\n${updatedBody}\nendobj\n`;
  const xrefOffset = objectOffset + Buffer.byteLength(objectText, 'latin1');
  const objectCount = Math.max(
    Number(source.match(/\/Size\s+(\d+)/)?.[1] ?? 0),
    ...objects.map((object) => Number(object[2]) + 1),
  );
  const update = `${objectText}xref\n${catalogId} 1\n${String(objectOffset).padStart(10, '0')} ${String(catalogGeneration).padStart(5, '0')} n \ntrailer\n<< /Size ${objectCount} /Root ${catalogId} ${catalogGeneration} R /Prev ${previousXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.concat([pdf, Buffer.from(`${separator}${update}`, 'latin1')]);
};

/** Render a self-contained thermal HTML document without loading the frontend SPA. */
export class ThermalReactPdfRenderer {
  private readonly pdfCache = new Map<string, { buffer: Buffer; expiresAt: number }>();
  private readonly inFlightRenders = new Map<string, Promise<Buffer>>();

  async render(html: string, width: ThermalPaperWidth, currentDocumentData?: unknown): Promise<Buffer> {
    if (currentDocumentData === undefined) return (await this.renderWithDiagnostics(html, width)).buffer;

    const cacheKey = createHash('sha256')
      .update(JSON.stringify({ version: THERMAL_RENDER_CACHE_VERSION, width, currentDocumentData }) ?? '')
      .digest('hex');
    const now = Date.now();
    for (const [key, entry] of this.pdfCache) {
      if (entry.expiresAt <= now) this.pdfCache.delete(key);
    }

    const cached = this.pdfCache.get(cacheKey);
    if (cached) {
      this.pdfCache.delete(cacheKey);
      this.pdfCache.set(cacheKey, cached);
      return Buffer.from(cached.buffer);
    }

    let render = this.inFlightRenders.get(cacheKey);
    if (!render) {
      render = this.renderWithDiagnostics(html, width).then(({ buffer }) => {
        if (this.pdfCache.size >= THERMAL_PDF_CACHE_MAX_ENTRIES) {
          const oldestKey = this.pdfCache.keys().next().value;
          if (oldestKey) this.pdfCache.delete(oldestKey);
        }
        this.pdfCache.set(cacheKey, { buffer: Buffer.from(buffer), expiresAt: Date.now() + THERMAL_PDF_CACHE_TTL_MS });
        return buffer;
      }).finally(() => this.inFlightRenders.delete(cacheKey));
      this.inFlightRenders.set(cacheKey, render);
    }

    return Buffer.from(await render);
  }

  async renderWithDiagnostics(html: string, width: ThermalPaperWidth): Promise<ThermalRenderResult> {
    const context = await pdfBrowserService.createContext();

    try {
      const page = await context.newPage();
      // Thermal layouts are width-driven. A tall screen viewport becomes extra
      // printable document extent when the receipt itself is absolutely
      // positioned, which Chromium paginates as blank roll pages.
      await page.setViewport({ width: width === '58mm' ? 219 : 302, height: 1, deviceScaleFactor: 1 });
      // Keep this renderer independent from the public frontend and any remote
      // resources accidentally introduced into a thermal template.
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (request.url().startsWith('data:') || request.url() === 'about:blank') {
          void request.continue();
        } else {
          void request.abort();
        }
      });
      await page.setContent(html, { waitUntil: 'load' });
      await page.emulateMediaType('print');
      await page.evaluate(async () => {
        const browserDocument = (globalThis as any).document;
        await browserDocument.fonts.ready;
        await Promise.all(Array.from(browserDocument.images as any[], (image) => image.decode().catch(() => undefined)));
        const requestAnimationFrame = (globalThis as any).requestAnimationFrame;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      const diagnostics = await page.evaluate(() => {
        const browserWindow = globalThis as any;
        const doc = browserWindow.document;
        const getStyle = browserWindow.getComputedStyle;
        const root = doc.querySelector('.thermal-receipt');
        if (!root) throw new Error('Thermal document root is missing');
        const rect = root.getBoundingClientRect();
        const visibleRects = Array.from(root.querySelectorAll('*'))
          .filter((node: any) => {
            const style = getStyle(node);
            const bounds = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
          })
          .map((node: any) => node.getBoundingClientRect());
        const bounds = [rect, ...visibleRects].reduce((combined: any, item: any) => ({
          top: Math.min(combined.top, item.top), left: Math.min(combined.left, item.left),
          right: Math.max(combined.right, item.right), bottom: Math.max(combined.bottom, item.bottom),
        }), { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom });
        const style = getStyle(root);
        const bodyStyle = getStyle(doc.body);
        return {
          document: { scrollHeight: doc.documentElement.scrollHeight, clientHeight: doc.documentElement.clientHeight },
          body: { scrollHeight: doc.body.scrollHeight, clientHeight: doc.body.clientHeight, minHeight: bodyStyle.minHeight, height: bodyStyle.height },
          root: {
            top: rect.top, left: rect.left, width: rect.width, height: rect.height, scrollHeight: root.scrollHeight,
            position: style.position, overflow: style.overflow, minHeight: style.minHeight, heightStyle: style.height,
          },
          contentBounds: { ...bounds, height: bounds.bottom - bounds.top },
          contentText: (root as any).innerText,
          pageBreakAvoidCount: Array.from(root.querySelectorAll('*')).filter((node: any) => {
            const childStyle = getStyle(node);
            return childStyle.breakInside === 'avoid' || childStyle.pageBreakInside === 'avoid';
          }).length,
        };
      });

      // The root is absolutely positioned for printing, so wrapper/document
      // scrollHeight can be zero or viewport-sized. Descendant bounds include
      // out-of-flow content and give the actual final content edge.
      const contentHeight = getThermalContentHeightPx(diagnostics.contentBounds);
      const buffer = setThermalPdfInitialFitToWidth(Buffer.from(await page.pdf(getThermalPdfOptions(width, contentHeight))));
      return { buffer, diagnostics };
    } finally {
      await pdfBrowserService.releaseContext(context);
    }
  }
}

export default new ThermalReactPdfRenderer();

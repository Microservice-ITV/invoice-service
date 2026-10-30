import { readFile } from "node:fs/promises";
import { join } from "node:path";
import storageService from "@/services/storage.service";
import logger from "@/utils/logger";
import env from "@/config/env";
import invoicePrintTokenService from "@/services/invoice-print-token.service";
import { InvoiceStatus } from "@/types/invoice";
import thermalReactPdfRenderer from '@/services/thermal-react-pdf-renderer.service';
import pdfBrowserService from '@/services/pdf-browser.service';
import { buildThermalInvoiceHtml } from '@/services/thermal-document-template';

export const REACT_PRINT_PDF_MARKER = "react-print-v19";
const INTER_FONT_DIRECTORY = join(process.cwd(), "assets", "fonts", "inter");
const INTER_FONT_FILES = [
  { filename: "Inter-Regular.woff2", weight: 400 },
  { filename: "Inter-Medium.woff2", weight: 500 },
  { filename: "Inter-SemiBold.woff2", weight: 600 },
  { filename: "Inter-Bold.woff2", weight: 700 },
] as const;

export interface InvoicePdfPayload {
  invoiceId: string;
  invoiceNumber: string;
  orderReference: string | null;
  orderId: string;
  shopId: string;
  shopName?: string | null;
  shopContactName?: string | null;
  shopContactEmail?: string | null;
  shopContactPhone?: string | null;
  shopAddress?: string | null;
  customerId: string;
  customerPhone?: string | null;
  billingAddress?: Record<string, unknown> | null;
  shippingAddress?: Record<string, unknown> | null;
  currency: string;
  subtotal: string;
  taxAmount: string;
  deliveryFee: string;
  discountAmount: string;
  grandTotal: string;
  paymentMethod: string | null;
  status: InvoiceStatus;
  createdAt: Date;
  customerName?: string | null;
  customerEmail?: string | null;
  lineItems?: Array<{
    sku?: string | null;
    variantName?: string | null;
    name: string;
    quantity: number;
    unitPrice: string;
    total: string;
  }>;
}

export class PdfGeneratorService {
  /** Build a thermal invoice directly from the already-authorized invoice snapshot. */
  async renderThermalInvoicePdf(payload: InvoicePdfPayload, width: '58mm' | '80mm'): Promise<Buffer> {
    const html = buildThermalInvoiceHtml(payload, width);
    return thermalReactPdfRenderer.render(html, width, {
      document: 'invoice',
      payload,
      printedYear: new Date().getFullYear(),
    });
  }
  async buildAndUploadInvoicePdf(payload: InvoicePdfPayload): Promise<string> {
    const pdfBuffer = await this.renderInvoicePdf(payload);
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const destination = `${payload.shopId}/${REACT_PRINT_PDF_MARKER}/${payload.invoiceNumber}-${uniqueSuffix}.pdf`;
    const pdfUrl = await storageService.uploadPdf(destination, pdfBuffer);

    logger.info(`Invoice PDF uploaded for ${payload.invoiceNumber}`);
    return pdfUrl;
  }

  async renderInvoicePdf(payload: InvoicePdfPayload): Promise<Buffer> {
    const context = await pdfBrowserService.createContext();
    try {
      const page = await context.newPage();

      page.on("console", (msg) => {
        logger.error(
          `[invoice-pdf:browser-console] ${msg.type()}: ${msg.text()}`,
        );
      });

      page.on("pageerror", (error) => {
        logger.error(
          `[invoice-pdf:page-error] ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

      page.on("requestfailed", (request) => {
        logger.error(
          `[invoice-pdf:request-failed] ${request.method()} ${request.url()} :: ${
            request.failure()?.errorText ?? "unknown"
          }`,
        );
      });

      page.on("response", (response) => {
        if (response.url().includes("/invoices/print/")) {
          logger.info(
            `[invoice-pdf:print-response] ${response.status()} ${response.url()}`,
          );
        }
      });

      const printUrl = this.buildPrintRouteUrl(payload);

      await page.setViewport({
        width: 1280,
        height: 1600,
        deviceScaleFactor: 1,
      });
      const response = await page.goto(printUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      if (!response || !response.ok()) {
        throw new Error(
          `Invoice print page returned HTTP ${response?.status() ?? "no response"} at ${printUrl}`,
        );
      }
      await page.waitForFunction("window.__INVOICE_READY__ === true", {
        timeout: 30000,
      });

      const renderError = (await page.evaluate(
        'window.__INVOICE_ERROR__ || ""',
      )) as string;
      if (renderError) {
        throw new Error(
          `Invoice print route failed to load the invoice: ${renderError}`,
        );
      }

      await page.addStyleTag({
        content: await this.getEmbeddedInterFontStyles(),
      });
      await page.evaluate(`(async () => {
        const weights = [400, 500, 600, 700];
        const loadedFaces = await Promise.all(weights.map(async (weight) => ({
          weight,
          faces: await document.fonts.load(weight + ' 12px Inter'),
        })));
        await document.fonts.ready;
        for (const { weight, faces } of loadedFaces) {
          if (faces.length === 0 || faces.some((face) => face.status !== 'loaded')) {
            throw new Error('Inter font weight ' + weight + ' did not load for invoice PDF rendering');
          }
        }
        const invoice = document.querySelector('.invoice-document');
        if (!invoice || !getComputedStyle(invoice).fontFamily.toLowerCase().includes('inter')) {
          throw new Error('Inter is not the computed invoice font for PDF rendering');
        }
      })()`);

      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "9mm", right: "9mm", bottom: "9mm", left: "9mm" },
      });
      return Buffer.from(pdfBuffer);
    } finally {
      await pdfBrowserService.releaseContext(context);
    }
  }

  private async getEmbeddedInterFontStyles(): Promise<string> {
    const fontFaces = await Promise.all(
      INTER_FONT_FILES.map(async ({ filename, weight }) => {
        let fontData: Buffer;
        try {
          fontData = await readFile(join(INTER_FONT_DIRECTORY, filename));
        } catch {
          // Source runs keep the bundled fonts under src/assets; Docker images
          // copy the same files to the application root for production.
          fontData = await readFile(join(process.cwd(), 'src', 'assets', 'fonts', 'inter', filename));
        }
        const dataUri = `data:font/woff2;base64,${fontData.toString("base64")}`;
        return `@font-face{font-family:'Inter';src:url('${dataUri}') format('woff2');font-style:normal;font-weight:${weight};font-display:block;}`;
      }),
    );

    return `${fontFaces.join("\n")}
.invoice-document.invoice-document,
.invoice-document.invoice-document * {
  font-family: 'Inter', sans-serif !important;
}`;
  }

  private buildPrintRouteUrl(payload: InvoicePdfPayload): string {
    const frontendBaseUrl = env.FRONTEND_BASE_URL?.trim().replace(/\/+$/, "");
    if (!frontendBaseUrl) {
      throw new Error(
        "FRONTEND_BASE_URL is not configured. Set it to the reachable frontend base URL " +
          "(for example http://frontendreact-node:5173 inside Docker) so invoice PDFs can be " +
          "rendered from the shared invoice print route.",
      );
    }

    const token = invoicePrintTokenService.issue({
      sub: payload.customerId,
      invoiceId: payload.invoiceId,
      invoiceNumber: payload.invoiceNumber,
      role: "customer",
    });

    return `${frontendBaseUrl}/account/invoices/${encodeURIComponent(payload.invoiceNumber)}/print?token=${encodeURIComponent(token)}`;
  }
}

export default new PdfGeneratorService();

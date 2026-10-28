import storageService from '@/services/storage.service';
import logger from '@/utils/logger';
import thermalReactPdfRenderer from '@/services/thermal-react-pdf-renderer.service';
import { buildThermalReceiptHtml, type ThermalInvoiceData } from '@/services/thermal-document-template';

export interface ReceiptPdfPayload {
  receiptId: string;
  receiptNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  orderId: string;
  orderReference: string | null;
  shopId: string;
  shopName: string | null;
  customerId: string;
  customerName: string | null;
  customerEmail: string | null;
  currency: string;
  subtotal: string;
  deliveryFee: string;
  taxAmount: string;
  discountAmount: string;
  grandTotal: string;
  paymentMethod: string | null;
  paymentGatewayRef: string | null;
  status: string;
  issuedAt: Date;
  shippingAddress?: Record<string, unknown> | null;
  lineItems?: Array<{ name: string; quantity: number; unitPrice?: string; total: string }>;
}

// Exported so receipt.service can verify stored references against the exact
// marker used when building object keys (they can never drift apart).
export const RECEIPT_PDF_MARKER = 'receipt-v1';

/**
 * Stores the existing receipt PDF artifact. Thermal downloads are rendered
 * from the already-authorized receipt and invoice snapshots at the requested width.
 *
 * Storage note: `storageService.uploadPdf` strips a leading `invoice-pdfs/`
 * from the key and always returns `invoice-pdfs/<objectKey>`, so the returned
 * reference is `invoice-pdfs/receipts/<shopId>/<marker>/<file>.pdf` and
 * `storageService.downloadPdf` strips the prefix again on read.
 */
export class ReceiptPdfService {
  async buildAndUploadReceiptPdf(payload: ReceiptPdfPayload): Promise<string> {
    const pdfBuffer = await this.renderReceiptPdf(payload);
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const destination = `receipts/${payload.shopId}/${RECEIPT_PDF_MARKER}/${payload.receiptNumber}-${uniqueSuffix}.pdf`;
    const pdfUrl = await storageService.uploadPdf(destination, pdfBuffer);

    logger.info(`Receipt PDF uploaded for ${payload.receiptNumber}`);
    return pdfUrl;
  }

  async renderReceiptPdf(
    payload: ReceiptPdfPayload,
    width: '58mm' | '80mm' = '80mm',
    currentInvoiceData: unknown = null,
  ): Promise<Buffer> {
    const invoice = currentInvoiceData && typeof currentInvoiceData === 'object'
      ? currentInvoiceData as Pick<ThermalInvoiceData, 'customerName' | 'lineItems'>
      : null;
    const html = buildThermalReceiptHtml(payload, width, invoice);
    return thermalReactPdfRenderer.render(html, width, {
      document: 'receipt',
      payload,
      currentInvoiceData,
      printedYear: new Date().getFullYear(),
    });
  }

}

export default new ReceiptPdfService();


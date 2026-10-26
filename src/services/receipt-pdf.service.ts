import storageService from '@/services/storage.service';
import logger from '@/utils/logger';
import env from '@/config/env';
import invoicePrintTokenService from '@/services/invoice-print-token.service';
import thermalReactPdfRenderer from '@/services/thermal-react-pdf-renderer.service';

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
  lineItems?: Array<{ name: string; quantity: number; total: string }>;
}

// Exported so receipt.service can verify stored references against the exact
// marker used when building object keys (they can never drift apart).
export const RECEIPT_PDF_MARKER = 'receipt-v1';

/**
 * Stores receipt PDFs using the same React print route as browser thermal
 * previews. Thermal downloads pass a width and are rendered on demand.
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

  async renderReceiptPdf(payload: ReceiptPdfPayload, width: '58mm' | '80mm' = '80mm'): Promise<Buffer> {
    const frontendBaseUrl = env.FRONTEND_BASE_URL?.trim().replace(/\/+$/, '');
    if (!frontendBaseUrl) throw new Error('FRONTEND_BASE_URL is required to render thermal receipt PDFs');
    const token = invoicePrintTokenService.issue({
      sub: payload.customerId,
      invoiceId: payload.invoiceId,
      invoiceNumber: payload.invoiceNumber,
      role: 'customer',
      document: 'receipt',
      receiptId: payload.receiptId,
    });
    const url = `${frontendBaseUrl}/account/invoices/${encodeURIComponent(payload.invoiceNumber)}/receipt/print?token=${encodeURIComponent(token)}&width=${encodeURIComponent(width)}`;
    return thermalReactPdfRenderer.render(url, width);
  }

}

export default new ReceiptPdfService();


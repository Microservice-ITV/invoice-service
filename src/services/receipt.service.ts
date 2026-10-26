import { Receipt, ReceiptStatus } from '@prisma/client';
import receiptRepository, { IssueReceiptInput } from '@/repositories/receipt.repository';
import receiptPdfService, { RECEIPT_PDF_MARKER, ReceiptPdfPayload } from '@/services/receipt-pdf.service';
import storageService from '@/services/storage.service';
import invoiceRepository from '@/repositories/invoice.repository';
import { canAccessInvoice, InvoiceAccessActor } from '@/services/invoice-access-policy';
import logger from '@/utils/logger';

/** Marker directory embedded in every receipt PDF object key. */
export const RECEIPT_PDF_PATH_MARKER = `/${RECEIPT_PDF_MARKER}/`;

/**
 * A stored receipt PDF reference is reusable only when it was produced by the
 * current renderer (same convention as `hasCurrentInvoicePdf`) and contains no
 * path traversal.
 */
export const hasCurrentReceiptPdf = (pdfUrl?: string | null): boolean =>
  Boolean(
    pdfUrl
    && pdfUrl.includes(RECEIPT_PDF_PATH_MARKER)
    && !pdfUrl.includes('..')
    && !pdfUrl.includes('\\'),
  );

/** Structural view of the PAID invoice record that seeds a receipt. */
export interface ReceiptIssueInvoice {
  id: string;
  invoiceNumber: string;
  orderId: string;
  orderReference?: string | null;
  shopId: string;
  shopName?: string | null;
  customerId: string;
  customerName?: string | null;
  customerEmail?: string | null;
  subtotal: { toString(): string };
  deliveryFee?: { toString(): string } | null;
  taxAmount: { toString(): string };
  discountAmount: { toString(): string };
  grandTotal: { toString(): string };
  currency: string;
  paymentMethod?: string | null;
  paymentGatewayRef?: string | null;
  status: string;
}

export interface ReceiptAccessResult {
  invoice: NonNullable<Awaited<ReturnType<typeof invoiceRepository.findById>>>;
  receipt: Receipt | null;
}

export class ReceiptService {
  /**
   * Issues the receipt for an invoice, but ONLY when the persisted invoice is
   * PAID. Any other status (UNPAID, PENDING_VERIFICATION, REJECTED, VOID,
   * REFUNDED) is refused so a receipt can never exist for money not received.
   *
   * Persistence errors propagate to the caller (RabbitMQ consumers nack and
   * log, HTTP handlers return 500) instead of being swallowed. The receipt row
   * is always committed BEFORE PDF generation is attempted; the PDF attempt is
   * background work whose failure is recorded on the row (pdfStatus/pdfError)
   * and can be retried independently without ever creating a second receipt.
   */
  async issueForInvoice(invoice: ReceiptIssueInvoice): Promise<Receipt | null> {
    if (invoice.status !== 'PAID') {
      return null;
    }

    const receipt = await receiptRepository.issueForInvoice(this.toIssueInput(invoice));

    void this.generateReceiptPdf(receipt).catch((error: unknown) => {
      logger.error(`Background receipt PDF generation failed for ${receipt.receiptNumber}`, error as Error);
    });

    return receipt;
  }

  /**
   * Updates the status of an existing receipt (VOID / REFUNDED). Never creates
   * and never deletes a receipt; a missing receipt makes this a no-op.
   */
  async updateReceiptStatus(
    invoiceId: string,
    status: Exclude<ReceiptStatus, 'ISSUED'>,
  ): Promise<Receipt | null> {
    return receiptRepository.updateStatusForInvoice(invoiceId, status);
  }

  /**
   * Loads the invoice, enforces `canAccessInvoice` (admin / owning customer /
   * owning shop), and returns its receipt. When the invoice is PAID but the
   * receipt is missing (feature added after the fact, or a previously failed
   * issuance), the receipt is issued now — healing is allowed only for PAID
   * invoices. Returns null when the invoice is missing or access is denied.
   */
  async getReceiptForInvoice(invoiceId: string, actor: InvoiceAccessActor): Promise<ReceiptAccessResult | null> {
    const invoice = await invoiceRepository.findById(invoiceId);
    if (!invoice || !canAccessInvoice(invoice, actor)) {
      return null;
    }

    let receipt = await receiptRepository.findByInvoiceId(invoice.id);
    if (!receipt && invoice.status === 'PAID') {
      receipt = await this.issueForInvoice(invoice);
    }

    return { invoice, receipt };
  }

  /**
   * Returns the receipt PDF bytes for an authorized caller, generating or
   * regenerating the document when it is missing or was produced by an older
   * renderer. Returns null when the caller may not access the invoice or the
   * invoice has no receipt (not PAID).
   */
  async downloadReceiptPdf(
    invoiceId: string,
    actor: InvoiceAccessActor,
    width?: '58mm' | '80mm',
  ): Promise<{ receipt: Receipt; buffer: Buffer } | null> {
    const context = await this.getReceiptForInvoice(invoiceId, actor);
    if (!context?.receipt) {
      return null;
    }

    const receipt = context.receipt;
    if (width) {
      const payload = this.toPdfPayload(receipt);
      const invoiceData = context.invoice as typeof context.invoice & { shippingAddress?: Record<string, unknown> | null; lineItems?: Array<{ name: string; quantity: number; total: string }> };
      payload.shippingAddress = invoiceData.shippingAddress ?? null;
      payload.lineItems = invoiceData.lineItems ?? [];
      return { receipt, buffer: await receiptPdfService.renderReceiptPdf(payload, width) };
    }
    if (receipt.pdfUrl && hasCurrentReceiptPdf(receipt.pdfUrl)) {
      try {
        return { receipt, buffer: await storageService.downloadPdf(receipt.pdfUrl) };
      } catch (error) {
        logger.warn('Stored receipt PDF could not be downloaded; regenerating it', {
          receiptId: receipt.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.generateReceiptPdf(receipt, {
      force: Boolean(receipt.pdfUrl),
      throwOnFailure: true,
    });

    const refreshed = await receiptRepository.findById(receipt.id);
    if (!refreshed?.pdfUrl || !hasCurrentReceiptPdf(refreshed.pdfUrl)) {
      throw new Error('Receipt PDF generation completed without a downloadable PDF');
    }

    return { receipt: refreshed, buffer: await storageService.downloadPdf(refreshed.pdfUrl) };
  }


  /**
   * Claim → render → upload → mark READY, mirroring the invoice PDF lifecycle.
   * Failures are persisted via markPdfFailed so a later call (download retry)
   * can regenerate without touching the receipt row itself.
   */
  async generateReceiptPdf(
    receipt: Receipt,
    options: { force?: boolean; throwOnFailure?: boolean } = {},
  ): Promise<boolean> {
    if (!options.force && hasCurrentReceiptPdf(receipt.pdfUrl)) {
      return true;
    }

    const force = options.force ?? Boolean(receipt.pdfUrl);
    if (!(await receiptRepository.claimPdfGeneration(receipt.id, { force }))) {
      if (options.throwOnFailure) {
        throw new Error('Receipt PDF generation is already in progress; please retry the download.');
      }
      return false;
    }

    try {
      const pdfUrl = await receiptPdfService.buildAndUploadReceiptPdf(this.toPdfPayload(receipt));
      await receiptRepository.markPdfReady(receipt.id, pdfUrl);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Receipt PDF generation failed';
      await receiptRepository.markPdfFailed(receipt.id, message);
      logger.error(`Failed to generate receipt PDF for ${receipt.receiptNumber}`, error as Error);
      if (options.throwOnFailure) {
        throw error instanceof Error ? error : new Error(message);
      }
      return false;
    }
  }

  private toIssueInput(invoice: ReceiptIssueInvoice): IssueReceiptInput {
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      orderId: invoice.orderId,
      orderReference: invoice.orderReference ?? null,
      shopId: invoice.shopId,
      shopName: invoice.shopName ?? null,
      customerId: invoice.customerId,
      customerName: invoice.customerName ?? null,
      customerEmail: invoice.customerEmail ?? null,
      subtotal: invoice.subtotal.toString(),
      deliveryFee: invoice.deliveryFee?.toString() ?? '0.00',
      taxAmount: invoice.taxAmount.toString(),
      discountAmount: invoice.discountAmount.toString(),
      grandTotal: invoice.grandTotal.toString(),
      currency: invoice.currency,
      paymentMethod: invoice.paymentMethod ?? null,
      paymentGatewayRef: invoice.paymentGatewayRef ?? null,
    };
  }

  private toPdfPayload(receipt: Receipt): ReceiptPdfPayload {
    return {
      receiptId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      invoiceId: receipt.invoiceId,
      invoiceNumber: receipt.invoiceNumber,
      orderId: receipt.orderId,
      orderReference: receipt.orderReference,
      shopId: receipt.shopId,
      shopName: receipt.shopName,
      customerId: receipt.customerId,
      customerName: receipt.customerName,
      customerEmail: receipt.customerEmail,
      currency: receipt.currency,
      subtotal: receipt.subtotal.toString(),
      deliveryFee: receipt.deliveryFee.toString(),
      taxAmount: receipt.taxAmount.toString(),
      discountAmount: receipt.discountAmount.toString(),
      grandTotal: receipt.grandTotal.toString(),
      paymentMethod: receipt.paymentMethod,
      paymentGatewayRef: receipt.paymentGatewayRef,
      status: receipt.status,
      issuedAt: receipt.issuedAt,
    };
  }
}

export default new ReceiptService();


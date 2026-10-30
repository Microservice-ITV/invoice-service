import prisma from '@/config/database';
import { Prisma, Receipt, ReceiptStatus } from '@prisma/client';

export interface IssueReceiptInput {
  invoiceId: string;
  invoiceNumber: string;
  orderId: string;
  orderReference: string | null;
  shopId: string;
  shopName: string | null;
  customerId: string;
  customerName: string | null;
  customerEmail: string | null;
  subtotal: string;
  deliveryFee: string;
  taxAmount: string;
  discountAmount: string;
  grandTotal: string;
  currency: string;
  paymentMethod: string | null;
  paymentGatewayRef: string | null;
}

/**
 * Persists receipts for PAID invoices.
 *
 * `issueForInvoice` is idempotent: the `receipts_invoiceId_key` UNIQUE
 * constraint guarantees one receipt per invoice even when concurrent
 * `payment.collected` / `order.paid` events race. A losing writer catches the
 * P2002 unique violation, re-reads the winner's row, and returns it without
 * creating anything. Non-unique persistence errors are always rethrown so the
 * calling RabbitMQ consumer follows the existing nack-and-log path instead of
 * silently dropping receipt issuance.
 */
export class ReceiptRepository {
  private dateStamp(date = new Date()): string {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }

  async findByInvoiceId(invoiceId: string): Promise<Receipt | null> {
    return prisma.receipt.findUnique({ where: { invoiceId } });
  }

  async findById(id: string): Promise<Receipt | null> {
    return prisma.receipt.findUnique({ where: { id } });
  }

  /**
   * Allocates the next receipt number (`RCP-YYYYMMDD-NNNNNN`) using the same
   * per-day sequence pattern as invoice numbering.
   */
  private async createReceiptNumber(tx: Prisma.TransactionClient): Promise<string> {
    const date = this.dateStamp();
    const sequence = await tx.receiptSequence.upsert({
      where: { date },
      update: { lastNumber: { increment: 1 } },
      create: { date, lastNumber: 1 },
    });
    return `RCP-${date}-${String(sequence.lastNumber).padStart(6, '0')}`;
  }

  /**
   * Idempotently creates the receipt for a PAID invoice.
   *
   * First checks for an existing receipt, then creates inside a transaction
   * (sequence allocation + insert). If a concurrent writer wins the race the
   * UNIQUE violation is caught and the winner's receipt is returned.
   */
  async issueForInvoice(input: IssueReceiptInput): Promise<Receipt> {
    const existing = await this.findByInvoiceId(input.invoiceId);
    if (existing) {
      return existing;
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const concurrent = await tx.receipt.findUnique({ where: { invoiceId: input.invoiceId } });
        if (concurrent) {
          return concurrent;
        }

        const receiptNumber = await this.createReceiptNumber(tx);
        const receipt = await tx.receipt.create({
          data: {
            receiptNumber,
            invoiceId: input.invoiceId,
            invoiceNumber: input.invoiceNumber,
            orderId: input.orderId,
            orderReference: input.orderReference,
            shopId: input.shopId,
            shopName: input.shopName,
            customerId: input.customerId,
            customerName: input.customerName,
            customerEmail: input.customerEmail,
            subtotal: input.subtotal,
            deliveryFee: input.deliveryFee,
            taxAmount: input.taxAmount,
            discountAmount: input.discountAmount,
            grandTotal: input.grandTotal,
            currency: input.currency,
            paymentMethod: input.paymentMethod,
            paymentGatewayRef: input.paymentGatewayRef,
            status: ReceiptStatus.ISSUED,
          },
        });
        await tx.thermalPdfJob.createMany({
          data: ['58mm', '80mm'].map((width) => ({ receiptId: receipt.id, width })),
          skipDuplicates: true,
        });
        return receipt;
      }, { timeout: 15_000 });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const winner = await this.findByInvoiceId(input.invoiceId);
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  /**
   * Updates the status of the existing receipt for an invoice (VOID /
   * REFUNDED). Never creates a receipt and never deletes one: when no receipt
   * exists this is a no-op (returns null).
   */
  async updateStatusForInvoice(
    invoiceId: string,
    status: Exclude<ReceiptStatus, 'ISSUED'>,
  ): Promise<Receipt | null> {
    const result = await prisma.receipt.updateMany({
      where: { invoiceId },
      data: { status },
    });

    if (result.count === 0) {
      return null;
    }

    return this.findByInvoiceId(invoiceId);
  }

  /**
   * Claims exclusive receipt PDF generation. Mirrors the invoice PDF claim:
   * by default only when no PDF exists yet; `force` allows re-render while
   * still respecting the in-progress lock (with a 15-minute stale escape).
   */
  async claimPdfGeneration(id: string, options: { force?: boolean } = {}): Promise<boolean> {
    const result = await prisma.receipt.updateMany({
      where: {
        id,
        ...(options.force ? {} : { pdfUrl: null }),
        OR: [
          { pdfStatus: { not: 'GENERATING' } },
          {
            pdfStatus: 'GENERATING',
            pdfUpdatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) },
          },
        ],
      },
      data: {
        pdfStatus: 'GENERATING',
        pdfError: null,
        pdfAttemptCount: { increment: 1 },
        pdfUpdatedAt: new Date(),
      },
    });

    return result.count === 1;
  }

  async markPdfReady(id: string, pdfUrl: string): Promise<Receipt> {
    return prisma.receipt.update({
      where: { id },
      data: {
        pdfUrl,
        pdfStatus: 'READY',
        pdfError: null,
        pdfUpdatedAt: new Date(),
      },
    });
  }

  async markPdfFailed(id: string, error: string): Promise<Receipt> {
    return prisma.receipt.update({
      where: { id },
      data: {
        pdfStatus: 'FAILED',
        pdfError: error.slice(0, 4000),
        pdfUpdatedAt: new Date(),
      },
    });
  }
}

export default new ReceiptRepository();



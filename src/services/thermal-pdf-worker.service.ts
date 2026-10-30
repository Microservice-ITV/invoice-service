import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '@/config/database';
import pdfGeneratorService from '@/services/pdf-generator.service';
import receiptPdfService, { type ReceiptPdfPayload } from '@/services/receipt-pdf.service';
import { THERMAL_RENDER_CACHE_VERSION } from '@/services/thermal-react-pdf-renderer.service';
import storageService from '@/services/storage.service';
import logger from '@/utils/logger';

const WIDTHS = ['58mm', '80mm'] as const;
const LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const POLL_MS = 1000;
const BATCH_SIZE = 4;

type ThermalJob = Prisma.ThermalPdfJobGetPayload<{
  include: { invoice: true; receipt: { include: { invoice: true } } };
}>;
type ThermalWidth = typeof WIDTHS[number];

const asAddress = (value: Prisma.JsonValue | null): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const asLineItems = (value: Prisma.JsonValue | null): Array<{ name: string; quantity: number; unitPrice: string; total: string; sku?: string | null }> =>
  Array.isArray(value) ? value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, Prisma.JsonValue>;
    if (typeof item.name !== 'string' || typeof item.quantity !== 'number' || typeof item.total !== 'string') return [];
    return [{
      name: item.name,
      quantity: item.quantity,
      unitPrice: typeof item.unitPrice === 'string' ? item.unitPrice : '0.00',
      total: item.total,
      sku: typeof item.sku === 'string' ? item.sku : null,
    }];
  }) : [];

/** Durable MySQL-backed queue shared by invoice and eligible receipt artifacts. */
export class ThermalPdfWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private idleWaiters: Array<() => void> = [];

  async enqueue(invoiceId: string): Promise<void> {
    await prisma.thermalPdfJob.createMany({ data: WIDTHS.map((width) => ({ invoiceId, width })), skipDuplicates: true });
  }

  async enqueueReceipt(receiptId: string): Promise<void> {
    // Receipt IDs exist only after the PAID-only issuance transaction commits.
    await prisma.thermalPdfJob.createMany({ data: WIDTHS.map((width) => ({ receiptId, width })), skipDuplicates: true });
  }

  async getStatus(invoiceId: string, width: ThermalWidth) {
    const where = { invoiceId_width: { invoiceId, width } };
    const job = await prisma.thermalPdfJob.findUnique({ where });
    return this.invalidateStaleReadyArtifact(job);
  }

  async getReceiptStatus(receiptId: string, width: ThermalWidth) {
    const where = { receiptId_width: { receiptId, width } };
    const job = await prisma.thermalPdfJob.findUnique({ where });
    return this.invalidateStaleReadyArtifact(job);
  }

  private async invalidateStaleReadyArtifact(
      job: Awaited<ReturnType<typeof prisma.thermalPdfJob.findUnique>>
    ) {
      if (!job || job.status !== 'READY' || job.templateVersion === THERMAL_RENDER_CACHE_VERSION) {
        return job;
      }

      await prisma.thermalPdfJob.updateMany({
        where: { id: job.id, status: 'READY', templateVersion: job.templateVersion },
        data: {
          status: 'PENDING',
          artifactRef: null,
          lastError: null,
          nextAttemptAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        },
      });

      return prisma.thermalPdfJob.findUnique({ where: { id: job.id } });
    }

  start(pollMs = POLL_MS): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.runOnce(); }, pollMs);
    this.timer.unref?.();
    void this.runOnce();
    logger.info('Thermal PDF worker started', { pollMs });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    logger.info('Thermal PDF worker stopped');
  }

  private eligibleJobs(now: Date): Prisma.ThermalPdfJobWhereInput {
    return {
      OR: [
        { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now } },
        { status: 'PROCESSING', OR: [{ leaseUntil: { lt: now } }, { leaseUntil: null }] },
      ],
    };
  }

  async runOnce(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (let index = 0; index < BATCH_SIZE && !this.stopped; index += 1) {
        if (!(await this.processNextJob())) break;
      }
    } catch (error) {
      logger.error('Thermal PDF worker poll failed', error as Error);
    } finally {
      this.running = false;
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  /** Atomically claims and handles at most one due or expired-lease job. */
  async processNextJob(): Promise<boolean> {
    const job = await prisma.thermalPdfJob.findFirst({
      where: this.eligibleJobs(new Date()),
      orderBy: { createdAt: 'asc' },
      include: { invoice: true, receipt: { include: { invoice: true } } },
    });
    if (!job) return false;

    const token = crypto.randomUUID();
    const claim = await prisma.thermalPdfJob.updateMany({
      where: { id: job.id, ...this.eligibleJobs(new Date()) },
      data: {
        status: 'PROCESSING', leaseToken: token,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        attempts: { increment: 1 }, lastError: null,
      },
    });
    if (claim.count !== 1) return false;
    await this.process(job, token);
    return true;
  }

  private async process(job: ThermalJob, token: string): Promise<void> {
    const width = job.width as ThermalWidth;
    const invoice = job.invoice ?? job.receipt?.invoice ?? null;
    try {
      if (!invoice || !['58mm', '80mm'].includes(width)) throw new Error('Thermal PDF job has no valid persisted document snapshot');

      let pdf: Buffer;
      let destination: string;
      let document: 'invoice' | 'receipt';
      if (job.invoice) {
        const lineItems = asLineItems(job.invoice.lineItems).map((item) => ({ ...item, sku: item.sku ?? null }));
        pdf = await pdfGeneratorService.renderThermalInvoicePdf({
          invoiceId: job.invoice.id, invoiceNumber: job.invoice.invoiceNumber, orderReference: job.invoice.orderReference,
          orderId: job.invoice.orderId, shopId: job.invoice.shopId, shopName: job.invoice.shopName,
          shopContactName: job.invoice.shopContactName, shopContactEmail: job.invoice.shopContactEmail,
          shopContactPhone: job.invoice.shopContactPhone, shopAddress: job.invoice.shopAddress,
          customerId: job.invoice.customerId, customerName: job.invoice.customerName, customerEmail: job.invoice.customerEmail,
          customerPhone: job.invoice.customerPhone, billingAddress: asAddress(job.invoice.billingAddress), shippingAddress: asAddress(job.invoice.shippingAddress),
          currency: job.invoice.currency, subtotal: job.invoice.subtotal.toString(), taxAmount: job.invoice.taxAmount.toString(),
          deliveryFee: job.invoice.deliveryFee.toString(), discountAmount: job.invoice.discountAmount.toString(), grandTotal: job.invoice.grandTotal.toString(),
          paymentMethod: job.invoice.paymentMethod, status: job.invoice.status, createdAt: job.invoice.createdAt, lineItems,
        }, width);
        destination = `thermal/${job.invoice.shopId}/${job.invoice.invoiceNumber}/${width}/${token}.pdf`;
        document = 'invoice';
      } else {
        const receipt = job.receipt;
        if (!receipt) throw new Error('Thermal receipt job has no persisted receipt snapshot');
        const lineItems = asLineItems(invoice.lineItems);
        const payload: ReceiptPdfPayload = {
          receiptId: receipt.id, receiptNumber: receipt.receiptNumber,
          invoiceId: receipt.invoiceId, invoiceNumber: receipt.invoiceNumber,
          orderId: receipt.orderId, orderReference: receipt.orderReference,
          shopId: receipt.shopId, shopName: receipt.shopName,
          customerId: receipt.customerId, customerName: receipt.customerName, customerEmail: receipt.customerEmail,
          currency: receipt.currency, subtotal: receipt.subtotal.toString(), deliveryFee: receipt.deliveryFee.toString(),
          taxAmount: receipt.taxAmount.toString(), discountAmount: receipt.discountAmount.toString(), grandTotal: receipt.grandTotal.toString(),
          paymentMethod: receipt.paymentMethod, paymentGatewayRef: receipt.paymentGatewayRef,
          status: receipt.status, issuedAt: receipt.issuedAt, shippingAddress: asAddress(invoice.shippingAddress), lineItems,
        };
        pdf = await receiptPdfService.renderReceiptPdf(payload, width, { customerName: receipt.customerName, lineItems });
        destination = `thermal/receipts/${receipt.shopId}/${receipt.receiptNumber}/${width}/${token}.pdf`;
        document = 'receipt';
      }

      const artifactRef = await storageService.uploadPdf(destination, pdf);
      const saved = await prisma.thermalPdfJob.updateMany({
        where: { id: job.id, status: 'PROCESSING', leaseToken: token },
        data: { status: 'READY', artifactRef, templateVersion: THERMAL_RENDER_CACHE_VERSION, lastError: null, leaseToken: null, leaseUntil: null },
      });
      if (saved.count !== 1) logger.warn('Thermal PDF worker lost lease after upload', { jobId: job.id, width, document });
      else logger.info('Thermal PDF artifact ready', {
        jobId: job.id, invoiceId: job.invoiceId, receiptId: job.receiptId,
        width, document, attempts: job.attempts + 1,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = job.attempts + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(attempts - 1, 12)));
      await prisma.thermalPdfJob.updateMany({
        where: { id: job.id, status: 'PROCESSING', leaseToken: token },
        data: {
          status: 'FAILED', lastError: message.slice(0, 4000),
          nextAttemptAt: new Date(Date.now() + backoff), leaseToken: null, leaseUntil: null,
        },
      });
      logger.error('Thermal PDF generation failed', Object.assign(new Error(message), {
        jobId: job.id, invoiceId: job.invoiceId, receiptId: job.receiptId,
        width, attempts, retryInMs: backoff,
      }));
    }
  }
}

export default new ThermalPdfWorker();

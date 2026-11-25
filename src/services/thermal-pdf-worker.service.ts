import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PdfArtifactKind } from '@prisma/client';
import prisma from '@/config/database';
import pdfGeneratorService, { REACT_PRINT_PDF_MARKER } from '@/services/pdf-generator.service';
import pdfRetentionService from '@/services/pdf-retention.service';
import receiptPdfService, { type ReceiptPdfPayload } from '@/services/receipt-pdf.service';
import { THERMAL_RENDER_CACHE_VERSION } from '@/services/thermal-react-pdf-renderer.service';
import orderSnapshotService from '@/services/order-snapshot.service';
import productVariantLookupService from '@/services/product-variant-lookup.service';
import logger from '@/utils/logger';
import { invoiceCacheService } from '@/services/invoice-cache.service';

const WIDTHS = ['58mm', '80mm'] as const;
const INVOICE_WIDTHS = ['A4', ...WIDTHS] as const;
const LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const POLL_MS = 1000;
const BATCH_SIZE = 4;
const WARMUP_INTERVAL_MS = 30_000;
const WARMUP_BATCH_SIZE = 50;

type ThermalJob = Prisma.ThermalPdfJobGetPayload<{
  include: { invoice: true; receipt: { include: { invoice: true } } };
}>;
type ThermalWidth = typeof WIDTHS[number];
type InvoicePdfWidth = typeof INVOICE_WIDTHS[number];

const getSafeErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') {
    return undefined;
  }
  return /^[A-Za-z0-9_-]{1,64}$/.test(error.code) ? error.code : undefined;
};

const asAddress = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

type ThermalLineItem = {
  name: string;
  quantity: number;
  unitPrice: string;
  total: string;
  sku?: string | null;
  variantName?: string | null;
  color?: string | null;
  size?: string | null;
};

const asLineItems = (value: Prisma.JsonValue | null): ThermalLineItem[] =>
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
      variantName: typeof item.variantName === 'string' ? item.variantName : null,
      color: typeof item.color === 'string' ? item.color : null,
      size: typeof item.size === 'string' ? item.size : null,
    }];
  }) : [];

/** Durable MySQL-backed queue shared by invoice and eligible receipt artifacts. */
export class ThermalPdfWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private idleWaiters: Array<() => void> = [];
  private lastWarmupAt = 0;

  async enqueue(invoiceId: string): Promise<void> {
    await prisma.thermalPdfJob.createMany({ data: INVOICE_WIDTHS.map((width) => ({ invoiceId, width })), skipDuplicates: true });
  }

  async requeueInvoice(invoiceId: string): Promise<void> {
    const now = new Date();
    const updated = await prisma.invoice.updateMany({
      where: {
        id: invoiceId,
        OR: [
          { pdfStatus: { not: 'CLEANING' } },
          { pdfStatus: 'CLEANING', OR: [{ pdfCleanupLeaseUntil: null }, { pdfCleanupLeaseUntil: { lte: now } }] },
        ],
      },
      data: { pdfStatus: 'PENDING', pdfUpdatedAt: now, pdfCleanupToken: null, pdfCleanupLeaseUntil: null },
    });
    if (updated.count === 0) return;
    await invoiceCacheService.invalidate();

    await prisma.thermalPdfJob.updateMany({
      where: {
        invoiceId,
        OR: [
          { status: { not: 'CLEANING' } },
          { status: 'CLEANING', OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }] },
        ],
      },
      data: {
        status: 'PENDING',
        artifactRef: null,
        templateVersion: null,
        lastError: null,
        nextAttemptAt: now,
        leaseToken: null,
        leaseUntil: null,
        cleanupToken: null,
        cleanupLeaseUntil: null,
      },
    });

    await prisma.thermalPdfJob.createMany({
      data: INVOICE_WIDTHS.map((width) => ({ invoiceId, width })),
      skipDuplicates: true,
    });
  }

  async requeueExpiredCleanupJob(jobId: string): Promise<boolean> {
    const now = new Date();
    const updated = await prisma.thermalPdfJob.updateMany({
      where: {
        id: jobId,
        status: 'CLEANING',
        OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }],
      },
      data: {
        status: 'PENDING',
        artifactRef: null,
        templateVersion: null,
        lastError: null,
        nextAttemptAt: now,
        leaseToken: null,
        leaseUntil: null,
        cleanupToken: null,
        cleanupLeaseUntil: null,
      },
    });
    return updated.count === 1;
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

  async getA4Status(invoiceId: string) {
    const job = await prisma.thermalPdfJob.findUnique({
      where: { invoiceId_width: { invoiceId, width: 'A4' } },
    });
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
      const currentVersion = job?.width === 'A4' ? REACT_PRINT_PDF_MARKER : THERMAL_RENDER_CACHE_VERSION;
      if (!job || job.status !== 'READY' || job.templateVersion === currentVersion) {
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
      if (job.width === 'A4' && job.invoiceId) {
        const updated = await prisma.invoice.updateMany({
          where: { id: job.invoiceId, pdfStatus: 'READY' },
          data: { pdfStatus: 'PENDING', pdfUpdatedAt: new Date() },
        });
        if (updated.count > 0) await invoiceCacheService.invalidate();
      }

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
      await this.warmMissingJobs();
      for (let index = 0; index < BATCH_SIZE && !this.stopped; index += 1) {
        if (!(await this.processNextJob())) break;
      }
    } catch (error) {
      logger.error('Thermal PDF worker poll failed', { errorCode: getSafeErrorCode(error) });
    } finally {
      this.running = false;
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  private async warmMissingJobs(): Promise<void> {
    if (Date.now() - this.lastWarmupAt < WARMUP_INTERVAL_MS) return;

    const invoiceJobs = await prisma.thermalPdfJob.findMany({
      where: {
        status: 'READY',
        OR: [
          { width: 'A4', templateVersion: null },
          { width: 'A4', templateVersion: { not: REACT_PRINT_PDF_MARKER } },
          { width: { in: [...WIDTHS] }, templateVersion: null },
          { width: { in: [...WIDTHS] }, templateVersion: { not: THERMAL_RENDER_CACHE_VERSION } },
        ],
      },
      take: WARMUP_BATCH_SIZE,
    });
    for (const job of invoiceJobs) {
      await this.invalidateStaleReadyArtifact(job);
    }

    const invoicesMissingJobs = await prisma.invoice.findMany({
      where: {
        OR: [
          { thermalPdfJobs: { none: { width: 'A4' } } },
          { thermalPdfJobs: { none: { width: '58mm' } } },
          { thermalPdfJobs: { none: { width: '80mm' } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: WARMUP_BATCH_SIZE,
      select: { id: true },
    });
    for (const invoice of invoicesMissingJobs) {
      await this.enqueue(invoice.id);
    }

    const receiptsMissingJobs = await prisma.receipt.findMany({
      where: {
        status: 'ISSUED',
        invoice: { status: 'PAID' },
        OR: [
          { thermalPdfJobs: { none: { width: '58mm' } } },
          { thermalPdfJobs: { none: { width: '80mm' } } },
        ],
      },
      orderBy: { issuedAt: 'asc' },
      take: WARMUP_BATCH_SIZE,
      select: { id: true },
    });
    for (const receipt of receiptsMissingJobs) {
      await this.enqueueReceipt(receipt.id);
    }
    this.lastWarmupAt = Date.now();
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
    const width = job.width as InvoicePdfWidth;
    const invoice = job.invoice ?? job.receipt?.invoice ?? null;
    try {
      if (!invoice || !['A4', '58mm', '80mm'].includes(width)) throw new Error('PDF job has no valid persisted document snapshot');
      if (job.receipt && (job.receipt.status !== 'ISSUED' || invoice.status !== 'PAID')) {
        throw new Error('Receipt PDF jobs require an issued receipt for a PAID invoice');
      }

      const snapshot = await orderSnapshotService.getInvoiceSnapshot(invoice.orderId).catch(() => null);
      const sellerMessage = snapshot?.sellerMessagesByShopId?.[invoice.shopId] ?? null;
      const snapshotShippingAddress = snapshot?.shippingAddress ?? invoice.shippingAddress ?? null;
      const lineItems = await productVariantLookupService.enrich(
        asLineItems(invoice.lineItems),
        snapshot?.items ?? [],
      );

      let pdf: Buffer | null = null;
      let destination: string;
      let document: 'invoice' | 'receipt';
      if (job.invoice) {
        const payload = {
          invoiceId: job.invoice.id, invoiceNumber: job.invoice.invoiceNumber, orderReference: job.invoice.orderReference,
          orderId: job.invoice.orderId, shopId: job.invoice.shopId, shopName: job.invoice.shopName,
          shopContactName: job.invoice.shopContactName, shopContactEmail: job.invoice.shopContactEmail,
          shopContactPhone: job.invoice.shopContactPhone, shopAddress: job.invoice.shopAddress,
          customerId: job.invoice.customerId, customerName: job.invoice.customerName, customerEmail: job.invoice.customerEmail,
          customerPhone: job.invoice.customerPhone, billingAddress: asAddress(job.invoice.billingAddress), shippingAddress: asAddress(snapshotShippingAddress),
          currency: job.invoice.currency, subtotal: job.invoice.subtotal.toString(), taxAmount: job.invoice.taxAmount.toString(),
          deliveryFee: job.invoice.deliveryFee.toString(), discountAmount: job.invoice.discountAmount.toString(), grandTotal: job.invoice.grandTotal.toString(),
          paymentMethod: job.invoice.paymentMethod, status: job.invoice.status, createdAt: job.invoice.createdAt, sellerMessage, lineItems,
        };
        if (width === 'A4') {
          if (job.invoice.pdfStatus === 'READY' && job.invoice.pdfUrl?.includes(`/${REACT_PRINT_PDF_MARKER}/`)) {
            destination = job.invoice.pdfUrl;
          } else {
            const claimed = await prisma.invoice.updateMany({
              where: {
                id: job.invoice.id,
                OR: [
                  { pdfStatus: { notIn: ['GENERATING', 'CLEANING'] } },
                  { pdfStatus: 'GENERATING', pdfUpdatedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
                  {
                    pdfStatus: 'CLEANING',
                    OR: [
                      { pdfCleanupLeaseUntil: null },
                      { pdfCleanupLeaseUntil: { lte: new Date() } },
                    ],
                  },
                ],
              },
              data: {
                pdfStatus: 'GENERATING', pdfError: null,
                pdfAttemptCount: { increment: 1 }, pdfUpdatedAt: new Date(),
                pdfCleanupToken: null, pdfCleanupLeaseUntil: null,
              },
            });
            if (claimed.count !== 1) throw new Error('A4 invoice PDF generation is already in progress');
            await invoiceCacheService.invalidate();
            try {
              destination = await pdfGeneratorService.buildAndUploadInvoicePdf(payload);
              await prisma.invoice.update({
                where: { id: job.invoice.id },
                data: { pdfUrl: destination, pdfStatus: 'READY', pdfError: null, pdfUpdatedAt: new Date() },
              });
              await invoiceCacheService.invalidate();
            } catch (error) {
              await prisma.invoice.update({
                where: { id: job.invoice.id },
                data: { pdfStatus: 'FAILED', pdfError: error instanceof Error ? error.message.slice(0, 4000) : 'PDF generation failed', pdfUpdatedAt: new Date() },
              });
              await invoiceCacheService.invalidate();
              throw error;
            }
          }
          document = 'invoice';
        } else {
          pdf = await pdfGeneratorService.renderThermalInvoicePdf(payload, width);
          destination = `thermal/${job.invoice.shopId}/${job.invoice.invoiceNumber}/${width}/${token}.pdf`;
          document = 'invoice';
        }
      } else {
        const receipt = job.receipt;
        if (!receipt) throw new Error('Thermal receipt job has no persisted receipt snapshot');
        if (width === 'A4') throw new Error('A4 receipt PDFs are not supported');
        const payload: ReceiptPdfPayload = {
          receiptId: receipt.id, receiptNumber: receipt.receiptNumber,
          invoiceId: receipt.invoiceId, invoiceNumber: receipt.invoiceNumber,
          orderId: receipt.orderId, orderReference: receipt.orderReference,
          shopId: receipt.shopId, shopName: receipt.shopName,
          customerId: receipt.customerId, customerName: receipt.customerName, customerEmail: receipt.customerEmail,
          customerPhone: invoice.customerPhone ?? snapshot?.customerPhone ?? null,
          currency: receipt.currency, subtotal: receipt.subtotal.toString(), deliveryFee: receipt.deliveryFee.toString(),
          taxAmount: receipt.taxAmount.toString(), discountAmount: receipt.discountAmount.toString(), grandTotal: receipt.grandTotal.toString(),
          paymentMethod: receipt.paymentMethod, paymentGatewayRef: receipt.paymentGatewayRef,
          status: receipt.status, issuedAt: receipt.issuedAt, shippingAddress: asAddress(snapshotShippingAddress), sellerMessage, lineItems,
        };
        pdf = await receiptPdfService.renderReceiptPdf(payload, width, {
          shopName: invoice.shopName,
          shopAddress: invoice.shopAddress,
          shopContactPhone: invoice.shopContactPhone,
          customerName: invoice.customerName ?? receipt.customerName,
          customerPhone: invoice.customerPhone ?? snapshot?.customerPhone ?? null,
          shippingAddress: asAddress(snapshotShippingAddress),
          sellerMessage,
          lineItems,
        });
        destination = `thermal/receipts/${receipt.shopId}/${receipt.receiptNumber}/${width}/${token}.pdf`;
        document = 'receipt';
      }

      let artifactRef: string;
      if (width === 'A4') {
        artifactRef = destination;
      } else {
        if (!pdf) throw new Error('PDF renderer returned no document');
        const sourceId = job.invoiceId ?? job.receiptId;
        if (!sourceId) throw new Error('PDF job has no persisted source identifier');
        artifactRef = await pdfRetentionService.uploadTrackedPdf({
          kind: job.invoiceId ? PdfArtifactKind.INVOICE_THERMAL : PdfArtifactKind.RECEIPT_THERMAL,
          sourceId,
          width,
          fileName: destination,
          buffer: pdf,
        });
      }
      const saved = await prisma.thermalPdfJob.updateMany({
        where: { id: job.id, status: 'PROCESSING', leaseToken: token },
        data: {
          status: 'READY', artifactRef,
          templateVersion: width === 'A4' ? REACT_PRINT_PDF_MARKER : THERMAL_RENDER_CACHE_VERSION,
          lastError: null, leaseToken: null, leaseUntil: null,
        },
      });
      if (saved.count !== 1) logger.warn('Thermal PDF worker lost lease after upload', { jobId: job.id, width, document });
      else logger.info('Thermal PDF artifact ready', {
        jobId: job.id,
        width, document, attempts: job.attempts + 1,
      });
    } catch (error) {
      const errorCode = getSafeErrorCode(error);
      const message = errorCode ? `Thermal PDF generation failed (${errorCode})` : 'Thermal PDF generation failed';
      const attempts = job.attempts + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(attempts - 1, 12)));
      await prisma.thermalPdfJob.updateMany({
        where: { id: job.id, status: 'PROCESSING', leaseToken: token },
        data: {
          status: 'FAILED', lastError: message.slice(0, 4000),
          nextAttemptAt: new Date(Date.now() + backoff), leaseToken: null, leaseUntil: null,
        },
      });
      logger.error('Thermal PDF generation failed', {
        jobId: job.id,
        width, attempts, retryInMs: backoff, errorCode,
      });
    }
  }
}

export default new ThermalPdfWorker();

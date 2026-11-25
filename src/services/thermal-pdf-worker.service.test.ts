import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mysql://invoice:invoice@localhost:3306/invoice_test';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.LOG_LEVEL = 'error';
process.env.MINIO_ENDPOINT = 'localhost';
process.env.MINIO_PORT = '9000';
process.env.MINIO_ACCESS_KEY = 'minioadmin';
process.env.MINIO_SECRET_KEY = 'minioadmin';
process.env.MINIO_BUCKET = 'invoices';
process.env.MINIO_USE_SSL = 'false';
process.env.PUBLIC_BASE_URL = 'http://localhost:9000';

import prisma from '@/config/database';
import pdfGeneratorService, { REACT_PRINT_PDF_MARKER } from '@/services/pdf-generator.service';
import pdfRetentionService from '@/services/pdf-retention.service';
import receiptPdfService from '@/services/receipt-pdf.service';
import { ThermalPdfWorker } from '@/services/thermal-pdf-worker.service';
import { THERMAL_RENDER_CACHE_VERSION } from '@/services/thermal-react-pdf-renderer.service';
import orderSnapshotService from '@/services/order-snapshot.service';
import productVariantLookupService from '@/services/product-variant-lookup.service';

const invoice = {
  id: 'invoice-1', invoiceNumber: 'INV-1', orderReference: 'ORDER-1', orderId: 'order-1',
  shopId: 'shop-1', shopName: 'Shop', shopContactName: null, shopContactEmail: null,
  shopContactPhone: null, shopAddress: null, customerId: 'customer-1', customerName: 'Customer',
  customerEmail: 'customer@example.com', customerPhone: null, billingAddress: null, shippingAddress: null,
  currency: 'MMK', subtotal: { toString: () => '10.00' }, taxAmount: { toString: () => '0.00' },
  deliveryFee: { toString: () => '0.00' }, discountAmount: { toString: () => '0.00' },
  grandTotal: { toString: () => '10.00' }, paymentMethod: 'CARD', status: 'PAID', createdAt: new Date(),
  lineItems: [{ name: 'Item', quantity: 1, unitPrice: '10.00', total: '10.00' }],
};

const invoiceJob = (width: 'A4' | '58mm' | '80mm', overrides: Record<string, unknown> = {}) => ({
  id: `job-${width}`, invoiceId: 'invoice-1', receiptId: null, width, attempts: 0,
  status: 'PENDING', invoice, receipt: null, ...overrides,
});

test('worker invalidates ready PDFs rendered with an older thermal template', async () => {
  const origFindUnique = prisma.thermalPdfJob.findUnique;
  const origUpdate = prisma.thermalPdfJob.updateMany;
  const staleJob = {
    id: 'job-58mm', status: 'READY', templateVersion: 'thermal-layout-v18',
    artifactRef: 'thermal/invoice-1/58mm/stale.pdf',
  };
  let updateWhere: Record<string, unknown> | undefined;
  let updateData: Record<string, unknown> | undefined;
  (prisma.thermalPdfJob as any).findUnique = async () => staleJob;
  (prisma.thermalPdfJob as any).updateMany = async (args: unknown) => {
    const update = args as { where: Record<string, unknown>; data: Record<string, unknown> };
    updateWhere = update.where;
    updateData = update.data;
    staleJob.status = String(update.data.status);
    return { count: 1 };
  };
  try {
    assert.notEqual(THERMAL_RENDER_CACHE_VERSION, staleJob.templateVersion);
    const status = await new ThermalPdfWorker().getStatus('invoice-1', '58mm');
    assert.equal(status?.status, 'PENDING');
    assert.equal(updateWhere?.status, 'READY');
    assert.equal(updateData?.status, 'PENDING');
    assert.equal(updateData?.artifactRef, null);
  } finally {
    prisma.thermalPdfJob.findUnique = origFindUnique;
    prisma.thermalPdfJob.updateMany = origUpdate;
  }
});

test('worker prepares both invoice widths and writes storage references', async () => {
  const restore: Array<() => void> = [];
  const rendered: string[] = [];
  const stored: string[] = [];
  let currentJob: ReturnType<typeof invoiceJob> | null = null;
  const origFind = prisma.thermalPdfJob.findFirst;
  const origUpdate = prisma.thermalPdfJob.updateMany;
  const origRender = pdfGeneratorService.renderThermalInvoicePdf;
  const origUpload = pdfRetentionService.uploadTrackedPdf;
  restore.push(() => { prisma.thermalPdfJob.findFirst = origFind; });
  restore.push(() => { prisma.thermalPdfJob.updateMany = origUpdate; });
  restore.push(() => { pdfGeneratorService.renderThermalInvoicePdf = origRender; });
  restore.push(() => { pdfRetentionService.uploadTrackedPdf = origUpload; });
  (prisma.thermalPdfJob as any).findFirst = async () => currentJob;
  (prisma.thermalPdfJob as any).updateMany = async (args: never) => {
    const { where, data } = args as unknown as { where: { status?: string; leaseToken?: string }; data: Record<string, unknown> };
    if (where.status !== 'PROCESSING') return { count: 1 } as never;
    if (data.status === 'PROCESSING') return { count: 1 } as never;
    return { count: 1 } as never;
  };
  pdfGeneratorService.renderThermalInvoicePdf = async (_data, width) => { rendered.push(width ?? '80mm'); return Buffer.from('%PDF'); };
  pdfRetentionService.uploadTrackedPdf = async ({ fileName }) => {
    stored.push(fileName);
    return `invoice-pdfs/${fileName}`;
  };
  try {
    const worker = new ThermalPdfWorker();
    for (const width of ['58mm', '80mm'] as const) {
      currentJob = invoiceJob(width);
      assert.equal(await worker.processNextJob(), true);
    }
    assert.deepEqual(rendered, ['58mm', '80mm']);
    assert.equal(stored.length, 2);
    assert.ok(stored.some((ref) => ref.includes('/58mm/')));
    assert.ok(stored.some((ref) => ref.includes('/80mm/')));
  } finally { restore.reverse().forEach((fn) => fn()); }
});

test('worker generates and stores the A4 artifact in the durable invoice job', async () => {
  const restore: Array<() => void> = [];
  const job = invoiceJob('A4', {
    invoice: { ...invoice, pdfUrl: null, pdfStatus: 'PENDING' },
  });
  const currentPdfUrl = `invoice-pdfs/shop-1/${REACT_PRINT_PDF_MARKER}/INV-1-ready.pdf`;
  let invoiceStatus: string | undefined;
  let storedJobVersion: string | undefined;
  let renderCount = 0;
  const origFind = prisma.thermalPdfJob.findFirst;
  const origJobUpdate = prisma.thermalPdfJob.updateMany;
  const origInvoiceClaim = prisma.invoice.updateMany;
  const origInvoiceUpdate = prisma.invoice.update;
  const origBuild = pdfGeneratorService.buildAndUploadInvoicePdf;
  const origThermalRender = pdfGeneratorService.renderThermalInvoicePdf;
  const origSnapshot = orderSnapshotService.getInvoiceSnapshot;
  const origEnrich = productVariantLookupService.enrich;
  restore.push(() => { prisma.thermalPdfJob.findFirst = origFind; });
  restore.push(() => { prisma.thermalPdfJob.updateMany = origJobUpdate; });
  restore.push(() => { prisma.invoice.updateMany = origInvoiceClaim; });
  restore.push(() => { prisma.invoice.update = origInvoiceUpdate; });
  restore.push(() => { pdfGeneratorService.buildAndUploadInvoicePdf = origBuild; });
  restore.push(() => { pdfGeneratorService.renderThermalInvoicePdf = origThermalRender; });
  restore.push(() => { orderSnapshotService.getInvoiceSnapshot = origSnapshot; });
  restore.push(() => { productVariantLookupService.enrich = origEnrich; });
  (prisma.thermalPdfJob as any).findFirst = async () => job;
  (prisma.thermalPdfJob as any).updateMany = async (args: never) => {
    const data = (args as unknown as { data: Record<string, unknown> }).data;
    if (data.status === 'READY') storedJobVersion = String(data.templateVersion);
    return { count: 1 } as never;
  };
  (prisma.invoice as any).updateMany = async () => ({ count: 1 });
  (prisma.invoice as any).update = async (args: never) => {
    const data = (args as unknown as { data: { pdfStatus: string } }).data;
    invoiceStatus = data.pdfStatus;
    return { ...invoice, pdfUrl: currentPdfUrl, pdfStatus: data.pdfStatus } as never;
  };
  pdfGeneratorService.buildAndUploadInvoicePdf = async () => { renderCount += 1; return currentPdfUrl; };
  pdfGeneratorService.renderThermalInvoicePdf = async () => { assert.fail('A4 jobs must not use the thermal renderer'); };
  orderSnapshotService.getInvoiceSnapshot = async () => null as never;
  productVariantLookupService.enrich = async (lineItems) => lineItems as never;
  try {
    assert.equal(await new ThermalPdfWorker().processNextJob(), true);
    assert.equal(renderCount, 1);
    assert.equal(invoiceStatus, 'READY');
    assert.equal(storedJobVersion, REACT_PRINT_PDF_MARKER);
  } finally { restore.reverse().forEach((fn) => fn()); }
});

test('worker recovers expired leases and backs off after storage failures', async () => {
  const origFind = prisma.thermalPdfJob.findFirst;
  const origUpdate = prisma.thermalPdfJob.updateMany;
  const origRender = pdfGeneratorService.renderThermalInvoicePdf;
  const origUpload = pdfRetentionService.uploadTrackedPdf;
  let query: unknown;
  let failureUpdate: Record<string, unknown> | undefined;
  (prisma.thermalPdfJob as any).findFirst = async (args: unknown) => {
    query = args;
    return invoiceJob('58mm', { status: 'PROCESSING', leaseUntil: new Date(Date.now() - 1000), attempts: 2 }) as never;
  };
  (prisma.thermalPdfJob as any).updateMany = async (args: never) => {
    const { data } = args as unknown as { data: Record<string, unknown> };
    if (data.status === 'FAILED') failureUpdate = data;
    return { count: 1 } as never;
  };
  pdfGeneratorService.renderThermalInvoicePdf = async () => Buffer.from('%PDF');
  pdfRetentionService.uploadTrackedPdf = async () => { throw new Error('storage unavailable'); };
  try {
    const worker = new ThermalPdfWorker();
    assert.equal(await worker.processNextJob(), true);
    const where = (query as { where: { OR: unknown[] } }).where;
    assert.ok(where.OR.some((clause) => JSON.stringify(clause).includes('leaseUntil')));
    assert.equal(failureUpdate?.status, 'FAILED');
    assert.ok(failureUpdate?.nextAttemptAt instanceof Date);
    assert.ok((failureUpdate?.nextAttemptAt as Date).getTime() > Date.now());
    assert.equal(failureUpdate?.leaseToken, null);
  } finally {
    prisma.thermalPdfJob.findFirst = origFind;
    prisma.thermalPdfJob.updateMany = origUpdate;
    pdfGeneratorService.renderThermalInvoicePdf = origRender;
    pdfRetentionService.uploadTrackedPdf = origUpload;
  }
});

test('atomic claim prevents concurrent workers from rendering the same job', async () => {
  const origFind = prisma.thermalPdfJob.findFirst;
  const origUpdate = prisma.thermalPdfJob.updateMany;
  const origRender = pdfGeneratorService.renderThermalInvoicePdf;
  const origUpload = pdfRetentionService.uploadTrackedPdf;
  let claims = 0;
  let renders = 0;
  (prisma.thermalPdfJob as any).findFirst = async () => invoiceJob('80mm');
  (prisma.thermalPdfJob as any).updateMany = async (args: never) => {
    const { data } = args as unknown as { data: Record<string, unknown> };
    if (data.status === 'PROCESSING') return { count: claims++ === 0 ? 1 : 0 } as never;
    return { count: 1 } as never;
  };
  pdfGeneratorService.renderThermalInvoicePdf = async () => { renders += 1; return Buffer.from('%PDF'); };
  pdfRetentionService.uploadTrackedPdf = async ({ fileName }) => `invoice-pdfs/${fileName}`;
  try {
    const worker = new ThermalPdfWorker();
    const results = await Promise.all([worker.processNextJob(), worker.processNextJob()]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(renders, 1);
  } finally {
    prisma.thermalPdfJob.findFirst = origFind;
    prisma.thermalPdfJob.updateMany = origUpdate;
    pdfGeneratorService.renderThermalInvoicePdf = origRender;
    pdfRetentionService.uploadTrackedPdf = origUpload;
  }
});

test('receipt jobs render from the persisted receipt and invoice snapshots', async () => {
  const origFind = prisma.thermalPdfJob.findFirst;
  const origUpdate = prisma.thermalPdfJob.updateMany;
  const origRender = receiptPdfService.renderReceiptPdf;
  const origUpload = pdfRetentionService.uploadTrackedPdf;
  let widthSeen = '';
  const receipt = {
    id: 'receipt-1', receiptNumber: 'RCP-1', invoiceId: 'invoice-1', invoiceNumber: 'INV-1',
    orderId: 'order-1', orderReference: 'ORDER-1', shopId: 'shop-1', shopName: 'Shop',
    customerId: 'customer-1', customerName: 'Customer', customerEmail: 'customer@example.com',
    currency: 'MMK', subtotal: { toString: () => '10.00' }, deliveryFee: { toString: () => '0.00' },
    taxAmount: { toString: () => '0.00' }, discountAmount: { toString: () => '0.00' },
    grandTotal: { toString: () => '10.00' }, paymentMethod: 'CARD', paymentGatewayRef: null,
    status: 'ISSUED', issuedAt: new Date(), invoice,
  };
  const renderedWidths: string[] = [];
  (prisma.thermalPdfJob as any).findFirst = async () => {
    const width = renderedWidths.length === 0 ? '58mm' : '80mm';
    return { ...invoiceJob(width), invoice: null, receiptId: 'receipt-1', receipt };
  };
  (prisma.thermalPdfJob as any).updateMany = async () => ({ count: 1 });
  receiptPdfService.renderReceiptPdf = async (_payload, width) => { widthSeen = width ?? '80mm'; renderedWidths.push(widthSeen); return Buffer.from('%PDF'); };
  pdfRetentionService.uploadTrackedPdf = async ({ fileName }) => `invoice-pdfs/${fileName}`;
  try {
    const worker = new ThermalPdfWorker();
    assert.equal(await worker.processNextJob(), true);
    assert.equal(await worker.processNextJob(), true);
    assert.deepEqual(renderedWidths, ['58mm', '80mm']);
  } finally {
    prisma.thermalPdfJob.findFirst = origFind;
    prisma.thermalPdfJob.updateMany = origUpdate;
    receiptPdfService.renderReceiptPdf = origRender;
    pdfRetentionService.uploadTrackedPdf = origUpload;
  }
});

test('expired cleanup leases requeue thermal PDF jobs for regeneration', async () => {
  const thermalPdfJobDelegate = prisma.thermalPdfJob as unknown as {
    updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  };
  const originalUpdate = thermalPdfJobDelegate.updateMany;
  let updateArgs: Record<string, unknown> | undefined;
  thermalPdfJobDelegate.updateMany = async (args) => {
    updateArgs = args;
    return { count: 1 };
  };
  try {
    const queued = await new ThermalPdfWorker().requeueExpiredCleanupJob('job-58mm');
    assert.equal(queued, true);
    const where = updateArgs?.where as {
      id: string;
      status: string;
      OR: Array<{ cleanupLeaseUntil: null | { lte: Date } }>;
    };
    const data = updateArgs?.data as Record<string, unknown>;
    assert.equal(where.id, 'job-58mm');
    assert.equal(where.status, 'CLEANING');
    assert.equal(where.OR[0].cleanupLeaseUntil, null);
    assert.ok(where.OR[1].cleanupLeaseUntil !== null);
    assert.ok(where.OR[1].cleanupLeaseUntil.lte instanceof Date);
    assert.equal(data.status, 'PENDING');
    assert.equal(data.artifactRef, null);
    assert.equal(data.cleanupToken, null);
    assert.equal(data.cleanupLeaseUntil, null);
    assert.ok(data.nextAttemptAt instanceof Date);
  } finally {
    thermalPdfJobDelegate.updateMany = originalUpdate;
  }
});

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
import pdfGeneratorService from '@/services/pdf-generator.service';
import receiptPdfService from '@/services/receipt-pdf.service';
import storageService from '@/services/storage.service';
import { ThermalPdfWorker } from '@/services/thermal-pdf-worker.service';

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

const invoiceJob = (width: '58mm' | '80mm', overrides: Record<string, unknown> = {}) => ({
  id: `job-${width}`, invoiceId: 'invoice-1', receiptId: null, width, attempts: 0,
  status: 'PENDING', invoice, receipt: null, ...overrides,
});

test('worker prepares both invoice widths and writes storage references', async () => {
  const restore: Array<() => void> = [];
  const rendered: string[] = [];
  const stored: string[] = [];
  let currentJob: ReturnType<typeof invoiceJob> | null = null;
  const origFind = prisma.thermalPdfJob.findFirst;
  const origUpdate = prisma.thermalPdfJob.updateMany;
  const origRender = pdfGeneratorService.renderThermalInvoicePdf;
  const origUpload = storageService.uploadPdf;
  restore.push(() => { prisma.thermalPdfJob.findFirst = origFind; });
  restore.push(() => { prisma.thermalPdfJob.updateMany = origUpdate; });
  restore.push(() => { pdfGeneratorService.renderThermalInvoicePdf = origRender; });
  restore.push(() => { storageService.uploadPdf = origUpload; });
  (prisma.thermalPdfJob as any).findFirst = async () => currentJob;
  (prisma.thermalPdfJob as any).updateMany = async (args: never) => {
    const { where, data } = args as unknown as { where: { status?: string; leaseToken?: string }; data: Record<string, unknown> };
    if (where.status !== 'PROCESSING') return { count: 1 } as never;
    if (data.status === 'PROCESSING') return { count: 1 } as never;
    return { count: 1 } as never;
  };
  pdfGeneratorService.renderThermalInvoicePdf = async (_data, width) => { rendered.push(width ?? '80mm'); return Buffer.from('%PDF'); };
  storageService.uploadPdf = async (ref) => { stored.push(ref); return ref; };
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

test('worker recovers expired leases and backs off after storage failures', async () => {
  const origFind = prisma.thermalPdfJob.findFirst;
  const origUpdate = prisma.thermalPdfJob.updateMany;
  const origRender = pdfGeneratorService.renderThermalInvoicePdf;
  const origUpload = storageService.uploadPdf;
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
  storageService.uploadPdf = async () => { throw new Error('storage unavailable'); };
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
    storageService.uploadPdf = origUpload;
  }
});

test('atomic claim prevents concurrent workers from rendering the same job', async () => {
  const origFind = prisma.thermalPdfJob.findFirst;
  const origUpdate = prisma.thermalPdfJob.updateMany;
  const origRender = pdfGeneratorService.renderThermalInvoicePdf;
  const origUpload = storageService.uploadPdf;
  let claims = 0;
  let renders = 0;
  (prisma.thermalPdfJob as any).findFirst = async () => invoiceJob('80mm');
  (prisma.thermalPdfJob as any).updateMany = async (args: never) => {
    const { data } = args as unknown as { data: Record<string, unknown> };
    if (data.status === 'PROCESSING') return { count: claims++ === 0 ? 1 : 0 } as never;
    return { count: 1 } as never;
  };
  pdfGeneratorService.renderThermalInvoicePdf = async () => { renders += 1; return Buffer.from('%PDF'); };
  storageService.uploadPdf = async (ref) => ref;
  try {
    const worker = new ThermalPdfWorker();
    const results = await Promise.all([worker.processNextJob(), worker.processNextJob()]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(renders, 1);
  } finally {
    prisma.thermalPdfJob.findFirst = origFind;
    prisma.thermalPdfJob.updateMany = origUpdate;
    pdfGeneratorService.renderThermalInvoicePdf = origRender;
    storageService.uploadPdf = origUpload;
  }
});

test('receipt jobs render from the persisted receipt and invoice snapshots', async () => {
  const origFind = prisma.thermalPdfJob.findFirst;
  const origUpdate = prisma.thermalPdfJob.updateMany;
  const origRender = receiptPdfService.renderReceiptPdf;
  const origUpload = storageService.uploadPdf;
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
  (prisma.thermalPdfJob as any).findFirst = async () => ({ ...invoiceJob('58mm'), invoice: null, receiptId: 'receipt-1', receipt });
  (prisma.thermalPdfJob as any).updateMany = async () => ({ count: 1 });
  receiptPdfService.renderReceiptPdf = async (_payload, width) => { widthSeen = width ?? '80mm'; return Buffer.from('%PDF'); };
  storageService.uploadPdf = async (ref) => ref;
  try {
    const worker = new ThermalPdfWorker();
    assert.equal(await worker.processNextJob(), true);
    assert.equal(widthSeen, '58mm');
  } finally {
    prisma.thermalPdfJob.findFirst = origFind;
    prisma.thermalPdfJob.updateMany = origUpdate;
    receiptPdfService.renderReceiptPdf = origRender;
    storageService.uploadPdf = origUpload;
  }
});

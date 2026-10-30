import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma, Receipt, ReceiptStatus } from '@prisma/client';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mysql://invoice:invoice@localhost:3306/invoice_test';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.LOG_LEVEL = 'error';
process.env.SERVICE_API_KEY = 'service-key-123456';
process.env.ORDER_SERVICE_URL = 'http://localhost:8000';
process.env.ORDER_SERVICE_API_KEY = 'order-key-123456';
process.env.MINIO_ENDPOINT = 'localhost';
process.env.MINIO_PORT = '9000';
process.env.MINIO_ACCESS_KEY = 'minioadmin';
process.env.MINIO_SECRET_KEY = 'minioadmin';
process.env.MINIO_BUCKET = 'invoices';
process.env.MINIO_USE_SSL = 'false';
process.env.PUBLIC_BASE_URL = 'http://localhost:9000';

import { ReceiptService, hasCurrentReceiptPdf, ReceiptIssueInvoice } from '@/services/receipt.service';
import receiptRepository, { ReceiptRepository, IssueReceiptInput } from '@/repositories/receipt.repository';
import receiptPdfService, { RECEIPT_PDF_MARKER } from '@/services/receipt-pdf.service';
import invoiceRepository from '@/repositories/invoice.repository';
import storageService from '@/services/storage.service';
import prisma from '@/config/database';
import thermalPdfWorker from '@/services/thermal-pdf-worker.service';

const makePaidInvoice = (overrides: Partial<ReceiptIssueInvoice> = {}): ReceiptIssueInvoice => ({
  id: 'invoice-1',
  invoiceNumber: 'INV-20261008-000001',
  orderId: 'order-1',
  orderReference: 'ORD-20261008-000001',
  shopId: 'shop-1',
  shopName: 'Shop One',
  customerId: 'customer-1',
  customerName: 'Customer One',
  customerEmail: 'customer@example.com',
  subtotal: new Prisma.Decimal('100.00'),
  deliveryFee: new Prisma.Decimal('5.00'),
  taxAmount: new Prisma.Decimal('0.00'),
  discountAmount: new Prisma.Decimal('0.00'),
  grandTotal: new Prisma.Decimal('105.00'),
  currency: 'MMK',
  paymentMethod: 'CARD',
  paymentGatewayRef: 'txn-real-1',
  status: 'PAID',
  ...overrides,
});

const makeReceipt = (overrides: Partial<Receipt> = {}): Receipt => ({
  id: 'receipt-1',
  receiptNumber: 'RCP-20261008-000001',
  invoiceId: 'invoice-1',
  invoiceNumber: 'INV-20261008-000001',
  orderId: 'order-1',
  orderReference: 'ORD-20261008-000001',
  shopId: 'shop-1',
  shopName: 'Shop One',
  customerId: 'customer-1',
  customerName: 'Customer One',
  customerEmail: 'customer@example.com',
  subtotal: new Prisma.Decimal('100.00'),
  deliveryFee: new Prisma.Decimal('5.00'),
  taxAmount: new Prisma.Decimal('0.00'),
  discountAmount: new Prisma.Decimal('0.00'),
  grandTotal: new Prisma.Decimal('105.00'),
  currency: 'MMK',
  paymentMethod: 'CARD',
  paymentGatewayRef: 'txn-real-1',
  status: ReceiptStatus.ISSUED,
  pdfUrl: null,
  pdfStatus: 'PENDING',
  pdfError: null,
  pdfAttemptCount: 0,
  pdfUpdatedAt: null,
  issuedAt: new Date('2026-10-08T00:00:00.000Z'),
  createdAt: new Date('2026-10-08T00:00:00.000Z'),
  updatedAt: new Date('2026-10-08T00:00:00.000Z'),
  ...overrides,
});

/** Stub that keeps eligible receipt job-enqueue assertions isolated from MySQL. */
const disableReceiptJobEnqueue = (): (() => void) => {
  const original = thermalPdfWorker.enqueueReceipt;
  thermalPdfWorker.enqueueReceipt = async () => undefined;
  return () => { thermalPdfWorker.enqueueReceipt = original; };
};

test('receipt eligibility: non-PAID invoices are never issued a receipt', async () => {
  const originalIssue = receiptRepository.issueForInvoice;
  const restoreJobs = disableReceiptJobEnqueue();
  let issueCalls = 0;
  receiptRepository.issueForInvoice = async () => {
    issueCalls += 1;
    return makeReceipt();
  };

  try {
    const service = new ReceiptService();
    const statuses: Array<ReceiptIssueInvoice['status']> = [
      'UNPAID',
      'PENDING_VERIFICATION',
      'REJECTED',
      'VOID',
      'REFUNDED',
    ];

    for (const status of statuses) {
      const result = await service.issueForInvoice(makePaidInvoice({ status }));
      assert.equal(result, null, `status ${status} must not produce a receipt`);
    }
    assert.equal(issueCalls, 0, 'repository must never be called for non-PAID invoices');
  } finally {
    restoreJobs();
    receiptRepository.issueForInvoice = originalIssue;
  }
});

test('receipt eligibility: a PAID invoice is issued a receipt built from its persisted data', async () => {
  const originalIssue = receiptRepository.issueForInvoice;
  const originalEnqueue = thermalPdfWorker.enqueueReceipt;
  let enqueueCalls = 0;
  thermalPdfWorker.enqueueReceipt = async () => { enqueueCalls += 1; };
  const captured: IssueReceiptInput[] = [];
  receiptRepository.issueForInvoice = async (input) => {
    captured.push(input);
    return makeReceipt();
  };

  try {
    const service = new ReceiptService();
    const invoice = makePaidInvoice();
    const result = await service.issueForInvoice(invoice);

    assert.equal(captured.length, 1);
    assert.equal(captured[0].invoiceId, invoice.id);
    assert.equal(captured[0].invoiceNumber, invoice.invoiceNumber);
    // Prisma.Decimal normalizes trailing zeros, so compare numerically.
    assert.equal(Number(captured[0].grandTotal), 105);
    assert.equal(Number(captured[0].subtotal), 100);
    assert.equal(Number(captured[0].deliveryFee), 5);
    assert.equal(Number(captured[0].taxAmount), 0);
    assert.equal(Number(captured[0].discountAmount), 0);
    assert.equal(captured[0].currency, 'MMK');
    assert.equal(captured[0].paymentGatewayRef, 'txn-real-1');
    assert.equal(result?.id, 'receipt-1');
    assert.equal(enqueueCalls, 1, 'a persisted eligible receipt confirms its durable jobs');
  } finally {
    thermalPdfWorker.enqueueReceipt = originalEnqueue;
    receiptRepository.issueForInvoice = originalIssue;
  }
});

test('duplicate issuance returns the already-persisted receipt instead of creating another', async () => {
  const originalIssue = receiptRepository.issueForInvoice;
  const restoreJobs = disableReceiptJobEnqueue();
  const existing = makeReceipt();
  let createCalls = 0;
  // Mirrors the repository contract: the unique invoiceId row already exists.
  receiptRepository.issueForInvoice = async () => {
    createCalls += 1;
    return existing;
  };

  try {
    const service = new ReceiptService();
    const first = await service.issueForInvoice(makePaidInvoice());
    const second = await service.issueForInvoice(makePaidInvoice());

    assert.equal(first, existing);
    assert.equal(second, existing);
    assert.equal(first?.id, second?.id);
    assert.equal(createCalls, 2, 'repository is responsible for the uniqueness guarantee');
  } finally {
    restoreJobs();
    receiptRepository.issueForInvoice = originalIssue;
  }
});

test('concurrent issuance resolves to one receipt via the unique invoiceId constraint', async () => {
  const originalFindUnique = prisma.receipt.findUnique;
  const originalTransaction = prisma.$transaction;

  // Simulate two racing writers: both pre-checks see no row, the loser's
  // INSERT hits receipts_invoiceId_key (P2002) and must return the winner's
  // row instead of throwing or creating a duplicate.
  const winner = makeReceipt({ id: 'receipt-winner' });
  let winnerVisible = false;
  let loserDetectedUniqueViolation = false;
  (prisma.receipt as { findUnique: unknown }).findUnique = async () => {
    // Only the post-P2002 recovery read may see the winner; pre-checks miss
    // (that is exactly what makes the race possible).
    return loserDetectedUniqueViolation ? winner : null;
  };
  (prisma as unknown as { $transaction: unknown }).$transaction = async (
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    const tx = {
      receipt: {
        findUnique: async () => null,
        create: async () => {
          if (winnerVisible) {
            loserDetectedUniqueViolation = true;
            const err = new Error('Unique constraint failed on receipts_invoiceId_key');
            (err as Error & { code: string }).code = 'P2002';
            throw err;
          }
          winnerVisible = true;
          return winner;
        },
      },
      receiptSequence: {
        upsert: async () => ({ lastNumber: 1 }),
      },
      thermalPdfJob: { createMany: async () => ({ count: 2 }) },
    };
    return fn(tx);
  };

  try {
    const repository = new ReceiptRepository();
    const input: IssueReceiptInput = {
      invoiceId: 'invoice-1',
      invoiceNumber: 'INV-20261008-000001',
      orderId: 'order-1',
      orderReference: null,
      shopId: 'shop-1',
      shopName: null,
      customerId: 'customer-1',
      customerName: null,
      customerEmail: null,
      subtotal: '100.00',
      deliveryFee: '5.00',
      taxAmount: '0.00',
      discountAmount: '0.00',
      grandTotal: '105.00',
      currency: 'MMK',
      paymentMethod: 'CARD',
      paymentGatewayRef: 'txn-real-1',
    };

    const first = await repository.issueForInvoice(input);
    const second = await repository.issueForInvoice(input);

    assert.equal(first.id, 'receipt-winner');
    assert.equal(second.id, 'receipt-winner');
    assert.equal(loserDetectedUniqueViolation, true, 'second write must hit the unique constraint');
  } finally {
    (prisma.receipt as { findUnique: unknown }).findUnique = originalFindUnique;
    (prisma as unknown as { $transaction: unknown }).$transaction = originalTransaction;
  }
});

test('receipt PDF failure is recorded and a retry succeeds without creating another receipt', async () => {
  const originalClaim = receiptRepository.claimPdfGeneration;
  const originalMarkReady = receiptRepository.markPdfReady;
  const originalMarkFailed = receiptRepository.markPdfFailed;
  const originalBuild = receiptPdfService.buildAndUploadReceiptPdf;
  const originalIssue = receiptRepository.issueForInvoice;

  let attempt = 0;
  let receiptIssueCalls = 0;
  const stored: { pdfUrl: string | null; pdfStatus: string; pdfError: string | null } = {
    pdfUrl: null,
    pdfStatus: 'PENDING',
    pdfError: null,
  };
  receiptRepository.issueForInvoice = async () => {
    receiptIssueCalls += 1;
    return makeReceipt();
  };
  receiptRepository.claimPdfGeneration = async () => true;
  receiptRepository.markPdfFailed = async (_id, error) => {
    stored.pdfStatus = 'FAILED';
    stored.pdfError = error;
    return makeReceipt(stored as never);
  };
  receiptRepository.markPdfReady = async (_id, pdfUrl) => {
    stored.pdfUrl = pdfUrl;
    stored.pdfStatus = 'READY';
    stored.pdfError = null;
    return makeReceipt({ pdfUrl, pdfStatus: 'READY' });
  };
  receiptPdfService.buildAndUploadReceiptPdf = async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error('puppeteer render failed');
    }
    return `invoice-pdfs/receipts/shop-1/${RECEIPT_PDF_MARKER}/RCP-1.pdf`;
  };

  try {
    const service = new ReceiptService();
    const receipt = makeReceipt();

    // First attempt fails: error is persisted, no throw, no new receipt.
    const firstTry = await service.generateReceiptPdf(receipt);
    assert.equal(firstTry, false);
    assert.equal(stored.pdfStatus, 'FAILED');
    assert.match(stored.pdfError ?? '', /puppeteer render failed/);
    assert.equal(receiptIssueCalls, 0, 'PDF failure must never re-issue the receipt');

    // Retry succeeds without touching the receipt row.
    const secondTry = await service.generateReceiptPdf(receipt);
    assert.equal(secondTry, true);
    assert.equal(stored.pdfStatus, 'READY');
    assert.equal(stored.pdfUrl?.includes(RECEIPT_PDF_MARKER), true);
    assert.equal(receiptIssueCalls, 0);
  } finally {
    receiptRepository.claimPdfGeneration = originalClaim;
    receiptRepository.markPdfReady = originalMarkReady;
    receiptRepository.markPdfFailed = originalMarkFailed;
    receiptPdfService.buildAndUploadReceiptPdf = originalBuild;
    receiptRepository.issueForInvoice = originalIssue;
  }
});

test('voiding or refunding an invoice updates the receipt status without deleting it', async () => {
  const originalUpdate = receiptRepository.updateStatusForInvoice;
  const calls: Array<{ invoiceId: string; status: string }> = [];
  receiptRepository.updateStatusForInvoice = async (invoiceId, status) => {
    calls.push({ invoiceId, status });
    return makeReceipt({ status: status as ReceiptStatus });
  };

  try {
    const service = new ReceiptService();
    const voided = await service.updateReceiptStatus('invoice-1', 'VOID');
    const refunded = await service.updateReceiptStatus('invoice-1', 'REFUNDED');

    assert.deepEqual(calls, [
      { invoiceId: 'invoice-1', status: 'VOID' },
      { invoiceId: 'invoice-1', status: 'REFUNDED' },
    ]);
    assert.equal(voided?.status, 'VOID');
    assert.equal(refunded?.status, 'REFUNDED');
  } finally {
    receiptRepository.updateStatusForInvoice = originalUpdate;
  }
});

test('receipt access: unauthorized callers get null and no issuance happens', async () => {
  const originalFindById = invoiceRepository.findById;
  const originalFindReceipt = receiptRepository.findByInvoiceId;
  const originalIssue = receiptRepository.issueForInvoice;
  const originalEnqueue = thermalPdfWorker.enqueueReceipt;

  const paidInvoice = { ...makePaidInvoice(), status: 'PAID' } as never;
  invoiceRepository.findById = async () => paidInvoice;
  receiptRepository.findByInvoiceId = async () => null;
  let issued = 0;
  receiptRepository.issueForInvoice = async (input) => {
    issued += 1;
    return makeReceipt({ invoiceId: input.invoiceId });
  };

  try {
    const service = new ReceiptService();
    thermalPdfWorker.enqueueReceipt = async () => {};

    // Missing invoice → null.
    invoiceRepository.findById = async () => null;
    assert.equal(await service.getReceiptForInvoice('missing', { role: 'admin' }), null);
    invoiceRepository.findById = async () => paidInvoice;

    // Another customer's invoice → null, even though it is PAID (heal must not run).
    const foreign = await service.getReceiptForInvoice('invoice-1', {
      role: 'customer',
      customerId: 'someone-else',
    });
    assert.equal(foreign, null);
    assert.equal(issued, 0, 'denied access must not trigger receipt issuance');

    // Owning customer → allowed and the PAID invoice is healed.
    const own = await service.getReceiptForInvoice('invoice-1', {
      role: 'customer',
      customerId: 'customer-1',
    });
    assert.equal(own?.invoice.id, 'invoice-1');
    assert.equal(issued, 1, 'PAID invoice without receipt is healed for the owner');

    // Admin → allowed.
    const admin = await service.getReceiptForInvoice('invoice-1', { role: 'admin' });
    assert.equal(admin?.receipt?.invoiceId, 'invoice-1');

    // Owning shop → allowed.
    const shop = await service.getReceiptForInvoice('invoice-1', {
      role: 'shopAdmin',
      shopId: 'shop-1',
    });
    assert.equal(shop?.receipt?.invoiceId, 'invoice-1');
  } finally {
    invoiceRepository.findById = originalFindById;
    receiptRepository.findByInvoiceId = originalFindReceipt;
    receiptRepository.issueForInvoice = originalIssue;
    thermalPdfWorker.enqueueReceipt = originalEnqueue;
  }
});


test('downloadReceiptPdf refuses access before touching storage and serves prepared artifacts', async () => {
  const originalFindById = invoiceRepository.findById;
  const originalFindReceipt = receiptRepository.findByInvoiceId;
  const originalFindReceiptById = receiptRepository.findById;
  const originalDownload = storageService.downloadPdf;
  const originalStatus = thermalPdfWorker.getReceiptStatus;

  const paidInvoice = { ...makePaidInvoice(), status: 'PAID' } as never;
  const downloads: string[] = [];
  invoiceRepository.findById = async () => paidInvoice;
  storageService.downloadPdf = async (url) => {
    downloads.push(url);
    return Buffer.from('%PDF-receipt');
  };

  try {
    const service = new ReceiptService();

    // Unauthorized caller: null, storage never touched.
    receiptRepository.findByInvoiceId = async () => makeReceipt();
    const denied = await service.downloadReceiptPdf('invoice-1', {
      role: 'customer',
      customerId: 'someone-else',
    });
    assert.equal(denied, null);
    assert.equal(downloads.length, 0);

    receiptRepository.findByInvoiceId = async () => makeReceipt();
    const currentUrl = 'thermal/receipts/shop-1/RCP-1/80mm/token.pdf';
    thermalPdfWorker.getReceiptStatus = async () => ({ status: 'READY', artifactRef: currentUrl } as never);
    const served = await service.downloadReceiptPdf('invoice-1', { role: 'admin' });
    assert.equal(served?.processing, false);
    if (served?.processing === false) assert.equal(served.buffer.toString(), '%PDF-receipt');
    assert.deepEqual(downloads, [currentUrl]);
  } finally {
    invoiceRepository.findById = originalFindById;
    receiptRepository.findByInvoiceId = originalFindReceipt;
    receiptRepository.findById = originalFindReceiptById;
    storageService.downloadPdf = originalDownload;
    thermalPdfWorker.getReceiptStatus = originalStatus;
  }
});

test('thermal receipt downloads render real invoice data at each requested paper width', async () => {
  const originalFindInvoice = invoiceRepository.findById;
  const originalFindReceipt = receiptRepository.findByInvoiceId;
  const originalStatus = thermalPdfWorker.getReceiptStatus;
  const originalDownload = storageService.downloadPdf;
  const widths: string[] = [];
  storageService.downloadPdf = async () => Buffer.from('%PDF-thermal');
  invoiceRepository.findById = async () => makePaidInvoice() as never;
  receiptRepository.findByInvoiceId = async () => makeReceipt();
  thermalPdfWorker.getReceiptStatus = async (_id, width) => {
    widths.push(width);
    return { status: 'READY', artifactRef: `thermal/${width}.pdf` } as never;
  };

  try {
    const service = new ReceiptService();
    for (const width of ['58mm', '80mm'] as const) {
      const result = await service.downloadReceiptPdf('invoice-1', { role: 'seller', shopId: 'shop-1' }, width);
      assert.equal(result?.processing, false);
      if (result?.processing === false) assert.equal(result.buffer.toString(), '%PDF-thermal');
    }
    assert.equal(await service.downloadReceiptPdf('invoice-1', { role: 'seller', shopId: 'shop-2' }, '80mm'), null);
    assert.deepEqual(widths, ['58mm', '80mm']);
  } finally {
    invoiceRepository.findById = originalFindInvoice;
    receiptRepository.findByInvoiceId = originalFindReceipt;
    thermalPdfWorker.getReceiptStatus = originalStatus;
    storageService.downloadPdf = originalDownload;
  }
});

test('hasCurrentReceiptPdf accepts only current renderer references without traversal', () => {
  assert.equal(
    hasCurrentReceiptPdf(`invoice-pdfs/receipts/shop-1/${RECEIPT_PDF_MARKER}/RCP-1.pdf`),
    true,
  );
  assert.equal(hasCurrentReceiptPdf('invoice-pdfs/receipts/shop-1/legacy/RCP-1.pdf'), false);
  assert.equal(
    hasCurrentReceiptPdf(`invoice-pdfs/receipts/shop-1/${RECEIPT_PDF_MARKER}/../etc.pdf`),
    false,
  );
  assert.equal(hasCurrentReceiptPdf(null), false);
});


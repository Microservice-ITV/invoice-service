import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';

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

import {
  buildPartialInvoiceRequestHash,
  allocateShopTotals,
  calculateShopSubtotal,
  hasCurrentInvoicePdf,
  normalizePartialInvoiceRequest,
  populateMissingInvoiceShopNames,
  requireMmkInvoiceCurrency,
  resolveInvoiceDisplayData,
  resolveInvoiceShopNames,
  validatePartialInvoiceShopSelection,
  validatePartialInvoiceRequest,
  validateRequestedQuantity,
} from '@/services/invoice.service';
import { InvoiceService } from '@/services/invoice.service';
import invoiceRepository, { InvoiceRepository } from '@/repositories/invoice.repository';
import receiptService from '@/services/receipt.service';
import orderSnapshotService, { OrderInvoiceSnapshot } from '@/services/order-snapshot.service';
import shopLookupService from '@/services/shop-lookup.service';
import pdfGeneratorService from '@/services/pdf-generator.service';
import storageService from '@/services/storage.service';
import invoiceNotificationPublisher, {
  buildInvoiceNotificationEvent,
} from '@/rabbitmq/publishers/invoice-notification.publisher';

test('notification PDF retrieval returns the exact stored invoice PDF and rejects unrelated references', async () => {
  const originalFindById = invoiceRepository.findById;
  const originalDownloadPdf = storageService.downloadPdf;
  const pdfUrl = 'invoice-pdfs/shop-1/react-print-v19/DNI-INV-1-123456789-123abc.pdf';
  const downloaded: string[] = [];
  const invoice = {
    id: 'invoice-1',
    invoiceNumber: 'DNI-INV-1',
    shopId: 'shop-1',
    pdfUrl,
    pdfStatus: 'READY',
  } as unknown as NonNullable<Awaited<ReturnType<typeof invoiceRepository.findById>>>;
  invoiceRepository.findById = async () => invoice;
  storageService.downloadPdf = async (reference) => {
    downloaded.push(reference);
    return Buffer.from('%PDF-stored-invoice');
  };

  try {
    const service = new InvoiceService();
    const result = await service.downloadInvoicePdfForNotification('invoice-1', pdfUrl);
    assert.equal(result?.invoice.id, 'invoice-1');
    assert.equal(result?.buffer.toString(), '%PDF-stored-invoice');
    assert.deepEqual(downloaded, [pdfUrl]);
    await assert.rejects(
      service.downloadInvoicePdfForNotification('invoice-1', 'invoice-pdfs/other-shop/private.pdf'),
      /Invoice PDF reference is invalid/,
    );
  } finally {
    invoiceRepository.findById = originalFindById;
    storageService.downloadPdf = originalDownloadPdf;
  }
});
test('invoice notification events include the real payment status and use stable logical IDs', () => {
  const invoice = {
    id: 'invoice-1',
    invoiceNumber: 'DNI-INV-1',
    orderId: 'order-1',
    shopId: 'shop-1',
    shopName: 'Shop One',
    customerId: 'customer-1',
    customerName: 'Customer One',
    customerEmail: 'customer@example.com',
    createdAt: new Date('2026-10-08T10:00:00.000Z'),
    paymentMethod: 'COD',
    status: 'UNPAID',
    currency: 'MMK',
    lineItems: [{
      name: 'Actual product',
      sku: 'SKU-1',
      quantity: 2,
      unitPrice: '50.00',
      total: '100.00',
    }],
    subtotal: { toString: () => '100.00' },
    taxAmount: { toString: () => '0.00' },
    deliveryFee: { toString: () => '5.00' },
    discountAmount: { toString: () => '0.00' },
    grandTotal: { toString: () => '105.00' },
    pdfUrl: 'invoice-pdfs/shop-1/react-print-v19/DNI-INV-1-123456789-123abc.pdf',
  };
  const cod = buildInvoiceNotificationEvent('invoice.generated', invoice);
  const paid = buildInvoiceNotificationEvent('invoice.paid', { ...invoice, status: 'PAID' });
  const repeatedPaid = buildInvoiceNotificationEvent('invoice.paid', { ...invoice, status: 'PAID' });

  assert.equal(cod.event_id, 'invoice:invoice-1:generated');
  assert.equal(cod.data.payment_status, 'UNPAID');
  assert.equal(cod.data.payment_method, 'COD');
  assert.equal(cod.data.customer_email, 'customer@example.com');
  assert.equal(cod.data.items instanceof Array, true);
  assert.equal(paid.data.payment_status, 'PAID');
  assert.equal(paid.event_id, repeatedPaid.event_id);
  assert.notEqual(cod.event_id, paid.event_id);
});

test('invoice notification waits for the stored PDF and publishing failure does not reject invoice work', async () => {
  const originalClaimPdf = invoiceRepository.claimPdfGeneration;
  const originalMarkPdfReady = invoiceRepository.markPdfReady;
  const originalFindById = invoiceRepository.findById;
  const originalBuildPdf = pdfGeneratorService.buildAndUploadInvoicePdf;
  const originalPublish = invoiceNotificationPublisher.publish;
  const events: string[] = [];
  const pdfUrl = 'invoice-pdfs/shop-1/react-print-v19/DNI-INV-1-123456789-123abc.pdf';
  const invoice = {
    id: 'invoice-1',
    invoiceNumber: 'DNI-INV-1',
    orderId: 'order-1',
    shopId: 'shop-1',
    shopName: 'Shop One',
    customerId: 'customer-1',
    customerName: 'Customer One',
    customerEmail: 'customer@example.com',
    subtotal: '100.00',
    taxAmount: '0.00',
    deliveryFee: '5.00',
    discountAmount: '0.00',
    grandTotal: '105.00',
    currency: 'MMK',
    paymentMethod: 'COD',
    status: 'UNPAID',
    createdAt: new Date('2026-10-08T10:00:00.000Z'),
    lineItems: [{ name: 'Actual product', sku: 'SKU-1', quantity: 1, unitPrice: '100.00', total: '100.00' }],
  };
  const persistedInvoice = {
    ...invoice,
    pdfUrl,
    pdfStatus: 'READY',
  } as unknown as NonNullable<Awaited<ReturnType<typeof invoiceRepository.findById>>>;
  invoiceRepository.claimPdfGeneration = async () => true;
  invoiceRepository.markPdfReady = async () => persistedInvoice;
  invoiceRepository.findById = async () => persistedInvoice;
  pdfGeneratorService.buildAndUploadInvoicePdf = async () => pdfUrl;
  invoiceNotificationPublisher.publish = async (eventType, sentInvoice) => {
    assert.equal(sentInvoice.pdfUrl, pdfUrl);
    events.push(eventType);
    if (eventType === 'invoice.generated') throw new Error('broker unavailable');
  };
  const privateService = new InvoiceService() as unknown as {
    generatePdfAndPublishNotification: (
      id: string,
      invoiceRecord: typeof invoice,
      eventType: 'invoice.generated' | 'invoice.paid',
      options?: { force?: boolean },
    ) => Promise<void>;
  };

  try {
    await assert.doesNotReject(privateService.generatePdfAndPublishNotification(
      invoice.id,
      invoice,
      'invoice.generated',
    ));
    assert.deepEqual(events, ['invoice.generated']);
    await privateService.generatePdfAndPublishNotification(
      invoice.id,
      invoice,
      'invoice.paid',
      { force: true },
    );
    assert.deepEqual(events, ['invoice.generated', 'invoice.paid']);
  } finally {
    invoiceRepository.claimPdfGeneration = originalClaimPdf;
    invoiceRepository.markPdfReady = originalMarkPdfReady;
    invoiceRepository.findById = originalFindById;
    pdfGeneratorService.buildAndUploadInvoicePdf = originalBuildPdf;
    invoiceNotificationPublisher.publish = originalPublish;
  }
});

const makeOrderSnapshot = (currency: string): OrderInvoiceSnapshot => ({
  orderId: 'order-1',
  checkoutId: 'checkout-1',
  customerId: 'customer-1',
  customerName: 'Customer One',
  customerEmail: 'customer@example.com',
  customerPhone: '555-0100',
  paymentStatus: 'PAID',
  paymentMethod: 'CARD',
  items: [{
    orderItemId: 'order-item-1',
    productId: 'product-1',
    productName: 'Test product',
    productSku: 'SKU-1',
    imageUrl: 'https://products.example.test/images/test-product.png',
    quantity: 1,
    unitPrice: '100.00',
    lineTotal: '100.00',
    shopId: 'shop-1',
    shopName: 'Shop One',
  }],
  currency,
  subtotal: '100.00',
  deliveryFee: '0.00',
  promotionDiscountTotal: '0.00',
  grandTotal: '100.00',
});

const makePaymentPayload = (currency: string) => ({
  paymentId: 'payment-1',
  orderId: 'order-1',
  transactionId: 'transaction-1',
  amount: 100,
  currency,
  paymentStatus: 'PAID' as const,
  paymentMethod: 'CARD',
});

test('only PDFs made by the current React print renderer are reusable', () => {
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v19/invoice.pdf'),
    true,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v15/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v14/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v13/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v12/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v11/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v10/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v9/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v8/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v7/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v6/invoice.pdf'),
    false,
  );
  assert.equal(
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v5/invoice.pdf'),
    false,
  );
  assert.equal(hasCurrentInvoicePdf('invoice-pdfs/shop-1/legacy-invoice.pdf'), false);
  assert.equal(hasCurrentInvoicePdf(null), false);
});

test('invoice download regenerates a stale PDF before returning it', async () => {
  const originalFindById = invoiceRepository.findById;
  const originalClaimPdfGeneration = invoiceRepository.claimPdfGeneration;
  const originalMarkPdfReady = invoiceRepository.markPdfReady;
  const originalBuildAndUploadInvoicePdf = pdfGeneratorService.buildAndUploadInvoicePdf;
  const originalDownloadPdf = storageService.downloadPdf;
  const stalePdf = Buffer.from('stale-pdf');
  const currentPdf = Buffer.from('current-pdf: Updated Customer: Updated Product');
  const stalePdfUrl = 'invoice-pdfs/shop-1/react-print-v18/invoice.pdf';
  const currentPdfUrl = 'invoice-pdfs/shop-1/react-print-v19/invoice.pdf';
  const downloadedUrls: string[] = [];
  const generatedPayloads: Parameters<typeof pdfGeneratorService.buildAndUploadInvoicePdf>[0][] = [];
  let savedPdfUrl = stalePdfUrl;
  const invoice = {
    id: 'invoice-1',
    invoiceNumber: 'INV-1',
    orderId: 'order-1',
    orderReference: null,
    shopId: 'shop-1',
    shopName: null,
    customerId: 'customer-1',
    customerName: 'Updated Customer',
    customerEmail: null,
    customerPhone: null,
    billingAddress: null,
    shippingAddress: null,
    shopContactName: null,
    shopContactEmail: null,
    shopContactPhone: null,
    shopAddress: null,
    lineItems: [{ name: 'Updated Product', quantity: 1, unitPrice: '100.00', total: '100.00' }],
    subtotal: new Prisma.Decimal('100.00'),
    taxAmount: new Prisma.Decimal('0.00'),
    deliveryFee: new Prisma.Decimal('0.00'),
    discountAmount: new Prisma.Decimal('0.00'),
    grandTotal: new Prisma.Decimal('100.00'),
    currency: 'MMK',
    paymentMethod: 'CARD',
    paymentGatewayRef: null,
    paymentSlipUrl: null,
    status: 'PAID' as const,
    pdfUrl: stalePdfUrl,
    pdfStatus: 'READY',
    pdfError: null,
    pdfAttemptCount: 1,
    pdfUpdatedAt: null,
    verifiedBy: null,
    verifiedAt: null,
    rejectionReason: null,
    verificationNote: null,
    refundAmount: null,
    refundMethod: null,
    refundReason: null,
    createdAt: new Date('2026-10-08T00:00:00.000Z'),
    updatedAt: new Date('2026-10-08T00:00:00.000Z'),
  } as NonNullable<Awaited<ReturnType<typeof invoiceRepository.findById>>>;

  invoiceRepository.findById = async () => ({ ...invoice, pdfUrl: savedPdfUrl });
  invoiceRepository.claimPdfGeneration = async () => true;
  invoiceRepository.markPdfReady = async (_id, pdfUrl) => {
    savedPdfUrl = pdfUrl;
    return { ...invoice, pdfUrl };
  };
  pdfGeneratorService.buildAndUploadInvoicePdf = async (payload) => {
    generatedPayloads.push(payload);
    return currentPdfUrl;
  };
  storageService.downloadPdf = async (url) => {
    downloadedUrls.push(url);
    return url === currentPdfUrl ? currentPdf : stalePdf;
  };

  try {
    const result = await new InvoiceService().downloadInvoicePdf('invoice-1', {
      role: 'customer',
      customerId: 'customer-1',
    });

    assert.equal(result?.buffer, currentPdf);
    assert.match(result?.buffer.toString() ?? '', /Updated Customer: Updated Product/);
    assert.equal(generatedPayloads[0]?.customerName, 'Updated Customer');
    assert.equal(generatedPayloads[0]?.lineItems?.[0]?.name, 'Updated Product');
    assert.deepEqual(downloadedUrls, [currentPdfUrl]);
  } finally {
    invoiceRepository.findById = originalFindById;
    invoiceRepository.claimPdfGeneration = originalClaimPdfGeneration;
    invoiceRepository.markPdfReady = originalMarkPdfReady;
    pdfGeneratorService.buildAndUploadInvoicePdf = originalBuildAndUploadInvoicePdf;
    storageService.downloadPdf = originalDownloadPdf;
  }
});

test('thermal invoice download passes the requested paper width to Puppeteer rendering', async () => {
  const originalFindById = invoiceRepository.findById;
  const originalRender = pdfGeneratorService.renderThermalInvoicePdf;
  const widths: string[] = [];
  invoiceRepository.findById = async () => ({
    id: 'invoice-1', invoiceNumber: 'INV-20261008-000001', orderReference: 'ORD-1', orderId: 'order-1',
    shopId: 'shop-1', customerId: 'customer-1', shopName: 'Shop', shopContactName: null,
    shopContactEmail: null, shopContactPhone: null, shopAddress: null, customerName: 'Customer',
    customerEmail: null, customerPhone: null, billingAddress: null,
    shippingAddress: { address_line_1: 'Real Street', city: 'Yangon' },
    currency: 'MMK', subtotal: { toString: () => '10' }, taxAmount: { toString: () => '0' },
    deliveryFee: { toString: () => '0' }, discountAmount: { toString: () => '0' },
    grandTotal: { toString: () => '10' }, lineItems: [{ name: 'Product', quantity: 1, total: '10', unitPrice: '10' }],
    paymentMethod: 'CASH', status: 'PAID', createdAt: new Date(),
  } as never);
  pdfGeneratorService.renderThermalInvoicePdf = async (_payload, width) => {
    widths.push(width);
    return Buffer.from('%PDF-thermal');
  };
  try {
    const service = new InvoiceService();
    for (const width of ['58mm', '80mm'] as const) {
      const result = await service.downloadThermalInvoicePdf('invoice-1', { role: 'seller', shopId: 'shop-1' }, width);
      assert.equal(result?.buffer.toString(), '%PDF-thermal');
    }
    assert.equal(await service.downloadThermalInvoicePdf('invoice-1', { role: 'seller', shopId: 'shop-2' }, '80mm'), null);
    assert.deepEqual(widths, ['58mm', '80mm']);
  } finally {
    invoiceRepository.findById = originalFindById;
    pdfGeneratorService.renderThermalInvoicePdf = originalRender;
  }
});

const withSnapshotDependencies = async <T>(
  snapshot: OrderInvoiceSnapshot,
  run: () => Promise<T>,
): Promise<T> => {
  const originalGetInvoiceSnapshot = orderSnapshotService.getInvoiceSnapshot;
  const originalGetShopInvoiceSnapshot = shopLookupService.getShopInvoiceSnapshot;
  const originalClaimPdfGeneration = invoiceRepository.claimPdfGeneration;
  const originalIssueReceipt = receiptService.issueForInvoice;
  const originalUpdateReceiptStatus = receiptService.updateReceiptStatus;
  orderSnapshotService.getInvoiceSnapshot = async () => snapshot;
  shopLookupService.getShopInvoiceSnapshot = async () => ({
    name: 'Shop One',
    contactName: 'Seller One',
    contactEmail: 'seller@example.com',
    contactPhone: '555-0101',
    address: 'Shop address',
  });
  invoiceRepository.claimPdfGeneration = async () => false;
  // Receipt issuance writes to the database; tests exercise receipt behavior
  // in receipt.service.test.ts, so here it defaults to a no-op.
  receiptService.issueForInvoice = async () => null;
  receiptService.updateReceiptStatus = async () => null;

  try {
    return await run();
  } finally {
    orderSnapshotService.getInvoiceSnapshot = originalGetInvoiceSnapshot;
    shopLookupService.getShopInvoiceSnapshot = originalGetShopInvoiceSnapshot;
    invoiceRepository.claimPdfGeneration = originalClaimPdfGeneration;
    receiptService.issueForInvoice = originalIssueReceipt;
    receiptService.updateReceiptStatus = originalUpdateReceiptStatus;
  }
};

const createInvoiceServiceWithoutPdfGeneration = (): InvoiceService => {
  const service = new InvoiceService();
  Object.defineProperty(service, 'generatePdfAsync', { value: async () => false });
  return service;
};

test('validateRequestedQuantity accepts valid partial and full quantities', () => {
  assert.doesNotThrow(() => validateRequestedQuantity('item-1', 2, 5));
  assert.doesNotThrow(() => validateRequestedQuantity('item-1', 5, 5));
});

test('validateRequestedQuantity rejects quantities greater than ordered quantity', () => {
  assert.throws(
    () => validateRequestedQuantity('item-1', 6, 5),
    /exceeds the ordered quantity/,
  );
});

test('validateRequestedQuantity rejects zero and negative quantities', () => {
  assert.throws(
    () => validateRequestedQuantity('item-1', 0, 5),
    /must be a positive integer/,
  );
  assert.throws(
    () => validateRequestedQuantity('item-1', -1, 5),
    /must be a positive integer/,
  );
});

test('invoice currency is always normalized to MMK regardless of the source currency', () => {
  assert.equal(requireMmkInvoiceCurrency('mmk'), 'MMK');
  assert.equal(requireMmkInvoiceCurrency('USD'), 'MMK');
  assert.equal(requireMmkInvoiceCurrency(null), 'MMK');
  assert.equal(requireMmkInvoiceCurrency(undefined), 'MMK');
});

test('COD invoices are created unpaid as soon as the order is placed', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  let storedStatus: string | undefined;
  let storedMethod: string | null | undefined;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    storedStatus = data.status;
    storedMethod = data.paymentMethod;
    return { id: 'invoice-cod', status: data.status, paymentMethod: data.paymentMethod } as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      paymentStatus: 'COD',
      paymentMethod: 'cod',
    }, async () => {
      await new InvoiceService().createInvoiceFromPayment({
        ...makePaymentPayload('MMK'),
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
      });
    });
    assert.equal(storedStatus, 'UNPAID');
    assert.equal(storedMethod, 'COD');
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('guest invoices persist customer details from the order snapshot when email is absent', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  let createData: Parameters<typeof originalCreate>[0] | undefined;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    createData = data;
    return { id: 'guest-invoice', status: data.status } as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      customerId: 'guest-12345678-1234-1234-1234-123456789abc',
      customerName: 'Guest Customer',
      customerEmail: null,
      customerPhone: null,
      shippingAddress: {
        full_name: 'Guest Customer',
        phone_no: '+959123456789',
        city: 'Yangon',
        address_line_1: '12 Example Street',
      },
    }, async () => {
      await new InvoiceService().createInvoiceFromPayment(makePaymentPayload('MMK'));
    });

    assert.equal(createData?.customerId, 'guest-12345678-1234-1234-1234-123456789abc');
    assert.equal(createData?.customerName, 'Guest Customer');
    assert.equal(createData?.customerEmail, null);
    assert.equal(createData?.customerPhone, '+959123456789');
    assert.deepEqual(createData?.shippingAddress, {
      full_name: 'Guest Customer',
      phone_no: '+959123456789',
      city: 'Yangon',
      address_line_1: '12 Example Street',
    });
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('COD collection updates the existing unpaid invoice instead of creating another', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  const originalFindAll = invoiceRepository.findAllByOrderId;
  const originalMarkCollected = invoiceRepository.markCollected;
  let created = false;
  let markedId: string | undefined;
  let collected = false;
  invoiceRepository.createPaidInvoiceFromPayment = async () => {
    created = true;
    return { id: 'invoice-new' } as Awaited<ReturnType<typeof originalCreate>>;
  };
  invoiceRepository.findAllByOrderId = async () => [{
    id: 'invoice-cod',
    paymentMethod: 'COD',
    paymentGatewayRef: 'payment-1',
    status: collected ? 'PAID' : 'UNPAID',
  }] as Awaited<ReturnType<typeof originalFindAll>>;
  invoiceRepository.markCollected = async (id, paymentGatewayRef) => {
    markedId = id;
    collected = true;
    return { id, status: 'PAID', paymentGatewayRef } as Awaited<ReturnType<typeof originalMarkCollected>>;
  };

  try {
    const result = await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      paymentStatus: 'COD',
      paymentMethod: 'cod',
    }, async () => new InvoiceService().createInvoiceFromPayment({
      ...makePaymentPayload('MMK'),
      transactionId: 'payment-1',
      paymentStatus: 'COLLECTED',
      paymentMethod: 'COD',
    }));
    assert.equal(created, false);
    assert.equal(markedId, 'invoice-cod');
    assert.equal((result as { id: string }).id, 'invoice-cod');
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
    invoiceRepository.findAllByOrderId = originalFindAll;
    invoiceRepository.markCollected = originalMarkCollected;
  }
});

test('duplicate COD collection events publish only one paid invoice notification', async () => {
  const originalFindAll = invoiceRepository.findAllByOrderId;
  const originalMarkCollected = invoiceRepository.markCollected;
  let status: 'UNPAID' | 'PAID' = 'UNPAID';
  let paymentGatewayRef: string | null = null;
  const notificationTypes: string[] = [];
  invoiceRepository.findAllByOrderId = async () => [{
    id: 'invoice-cod',
    paymentMethod: 'COD',
    paymentGatewayRef,
    status,
  }] as Awaited<ReturnType<typeof originalFindAll>>;
  invoiceRepository.markCollected = async (id, reference) => {
    status = 'PAID';
    paymentGatewayRef = reference;
    return { id, status, paymentGatewayRef: reference } as Awaited<ReturnType<typeof originalMarkCollected>>;
  };

  const service = new InvoiceService();
  Object.defineProperty(service, 'generatePdfAndPublishNotification', {
    value: async (_id: string, _invoice: unknown, eventType: string) => {
      notificationTypes.push(eventType);
    },
  });
  const collectedPayment = {
    ...makePaymentPayload('MMK'),
    transactionId: 'payment-1',
    paymentStatus: 'COLLECTED' as const,
    paymentMethod: 'COD',
  };

  try {
    await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      paymentStatus: 'COD',
      paymentMethod: 'COD',
    }, async () => {
      await service.createInvoiceFromPayment(collectedPayment);
      await service.createInvoiceFromPayment(collectedPayment);
    });
    assert.deepEqual(notificationTypes, ['invoice.paid']);
    assert.equal(status, 'PAID');
  } finally {
    invoiceRepository.findAllByOrderId = originalFindAll;
    invoiceRepository.markCollected = originalMarkCollected;
  }
});

test('COD collection attaches its real payment reference to a replayed invoice', async () => {
  const originalFindAll = invoiceRepository.findAllByOrderId;
  const originalMarkCollected = invoiceRepository.markCollected;
  let status: 'UNPAID' | 'PAID' = 'UNPAID';
  let gatewayReference: string | null = null;
  invoiceRepository.findAllByOrderId = async () => [{
    id: 'replayed-cod-invoice',
    paymentMethod: 'COD',
    paymentGatewayRef: gatewayReference,
    status,
  }] as Awaited<ReturnType<typeof originalFindAll>>;
  invoiceRepository.markCollected = async (id, paymentGatewayRef) => {
    status = 'PAID';
    gatewayReference = paymentGatewayRef;
    return { id, status, paymentGatewayRef } as Awaited<ReturnType<typeof originalMarkCollected>>;
  };

  try {
    const result = await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      paymentStatus: 'COD',
      paymentMethod: 'COD',
    }, async () => new InvoiceService().createInvoiceFromPayment({
      ...makePaymentPayload('MMK'),
      paymentStatus: 'COLLECTED',
      paymentMethod: 'COD',
    }));
    assert.equal((result as { id: string }).id, 'replayed-cod-invoice');
    assert.equal(gatewayReference, 'transaction-1');
  } finally {
    invoiceRepository.findAllByOrderId = originalFindAll;
    invoiceRepository.markCollected = originalMarkCollected;
  }
});

test('COD collection rejects an event for a different payment without creating an invoice', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  const originalFindAll = invoiceRepository.findAllByOrderId;
  let created = false;
  invoiceRepository.createPaidInvoiceFromPayment = async () => {
    created = true;
    return { id: 'invoice-new' } as Awaited<ReturnType<typeof originalCreate>>;
  };
  invoiceRepository.findAllByOrderId = async () => [{
    id: 'invoice-cod',
    paymentMethod: 'COD',
    paymentGatewayRef: 'different-payment',
    status: 'UNPAID',
  }] as Awaited<ReturnType<typeof originalFindAll>>;

  try {
    await assert.rejects(
      withSnapshotDependencies({
        ...makeOrderSnapshot('MMK'),
        paymentStatus: 'COD',
        paymentMethod: 'cod',
      }, async () => new InvoiceService().createInvoiceFromPayment({
        ...makePaymentPayload('MMK'),
        transactionId: 'payment-1',
        paymentStatus: 'COLLECTED',
        paymentMethod: 'COD',
      })),
      /Collected payment does not match an existing COD invoice/,
    );
    assert.equal(created, false);
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
    invoiceRepository.findAllByOrderId = originalFindAll;
  }
});

test('replayed COD collection returns the matching paid invoice without creating another', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  const originalFindAll = invoiceRepository.findAllByOrderId;
  let created = false;
  invoiceRepository.createPaidInvoiceFromPayment = async () => {
    created = true;
    return { id: 'invoice-new' } as Awaited<ReturnType<typeof originalCreate>>;
  };
  invoiceRepository.findAllByOrderId = async () => [{
    id: 'invoice-cod',
    paymentMethod: 'COD',
    paymentGatewayRef: 'payment-1',
    status: 'PAID',
  }] as Awaited<ReturnType<typeof originalFindAll>>;

  try {
    const result = await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      paymentStatus: 'COD',
      paymentMethod: 'cod',
    }, async () => new InvoiceService().createInvoiceFromPayment({
      ...makePaymentPayload('MMK'),
      transactionId: 'payment-1',
      paymentStatus: 'COLLECTED',
      paymentMethod: 'COD',
    }));
    assert.equal((result as { id: string }).id, 'invoice-cod');
    assert.equal(created, false);
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
    invoiceRepository.findAllByOrderId = originalFindAll;
  }
});

test('paid invoice creation stores the validated MMK source currency', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  let storedCurrency: string | undefined;
  let storedLineItemImage: string | null | undefined;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    storedCurrency = data.currency;
    storedLineItemImage = data.lineItems[0]?.imageUrl;
    return { id: 'invoice-1', currency: data.currency } as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    await withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => {
      await new InvoiceService().createInvoiceFromPayment(makePaymentPayload('MMK'));
    });
    assert.equal(storedCurrency, 'MMK');
    assert.equal(storedLineItemImage, 'https://products.example.test/images/test-product.png');
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('customer invoice detail hydrates missing product images from the order snapshot', async () => {
  const originalFindDocumentByInvoiceNumber = invoiceRepository.findDocumentByInvoiceNumber;
  const originalGetInvoiceSnapshot = orderSnapshotService.getInvoiceSnapshot;
  invoiceRepository.findDocumentByInvoiceNumber = async () => ({
    id: 'invoice-1',
    invoiceNumber: 'INV-1',
    customerId: 'customer-1',
    orderId: 'order-1',
    lineItems: [{
      orderItemId: 'order-item-1',
      name: 'Test product',
      sku: 'SKU-1',
      quantity: 1,
      unitPrice: '100.00',
      total: '100.00',
      imageUrl: null,
    }],
  }) as Awaited<ReturnType<typeof originalFindDocumentByInvoiceNumber>>;
  orderSnapshotService.getInvoiceSnapshot = async () => makeOrderSnapshot('MMK');

  try {
    const invoice = await new InvoiceService().getCustomerInvoiceByNumber('INV-1', 'customer-1');
    assert.equal(
      invoice?.lineItems?.[0]?.imageUrl,
      'https://products.example.test/images/test-product.png',
    );
  } finally {
    invoiceRepository.findDocumentByInvoiceNumber = originalFindDocumentByInvoiceNumber;
    orderSnapshotService.getInvoiceSnapshot = originalGetInvoiceSnapshot;
  }
});

test('invoice detail skips order snapshot lookup when persisted images are available', async () => {
  const originalFindDocumentByInvoiceNumber = invoiceRepository.findDocumentByInvoiceNumber;
  const originalGetInvoiceSnapshot = orderSnapshotService.getInvoiceSnapshot;
  let snapshotLookupCount = 0;
  invoiceRepository.findDocumentByInvoiceNumber = async () => ({
    id: 'invoice-1',
    invoiceNumber: 'INV-1',
    customerId: 'customer-1',
    orderId: 'order-1',
    lineItems: [{
      orderItemId: 'order-item-1',
      name: 'Test product',
      sku: 'SKU-1',
      quantity: 1,
      unitPrice: '100.00',
      total: '100.00',
      imageUrl: 'https://products.example.test/images/persisted.png',
    }],
  }) as Awaited<ReturnType<typeof originalFindDocumentByInvoiceNumber>>;
  orderSnapshotService.getInvoiceSnapshot = async () => {
    snapshotLookupCount += 1;
    throw new Error('Order Service should not be called');
  };

  try {
    const invoice = await new InvoiceService().getCustomerInvoiceByNumber('INV-1', 'customer-1');
    assert.equal(invoice?.lineItems?.[0]?.imageUrl, 'https://products.example.test/images/persisted.png');
    assert.equal(snapshotLookupCount, 0);
  } finally {
    invoiceRepository.findDocumentByInvoiceNumber = originalFindDocumentByInvoiceNumber;
    orderSnapshotService.getInvoiceSnapshot = originalGetInvoiceSnapshot;
  }
});

test('invoice detail succeeds with a null image when optional snapshot hydration fails', async () => {
  const originalFindDocumentByInvoiceNumber = invoiceRepository.findDocumentByInvoiceNumber;
  const originalGetInvoiceSnapshot = orderSnapshotService.getInvoiceSnapshot;
  invoiceRepository.findDocumentByInvoiceNumber = async () => ({
    id: 'invoice-1',
    invoiceNumber: 'INV-1',
    customerId: 'customer-1',
    orderId: 'order-1',
    lineItems: [{
      orderItemId: 'order-item-1',
      name: 'Test product',
      sku: 'SKU-1',
      quantity: 1,
      unitPrice: '100.00',
      total: '100.00',
      imageUrl: null,
    }],
  }) as Awaited<ReturnType<typeof originalFindDocumentByInvoiceNumber>>;
  orderSnapshotService.getInvoiceSnapshot = async () => {
    throw new Error('Order Service unavailable');
  };

  try {
    const invoice = await new InvoiceService().getCustomerInvoiceByNumber('INV-1', 'customer-1');
    assert.equal(invoice?.invoiceNumber, 'INV-1');
    assert.equal(invoice?.lineItems?.[0]?.imageUrl, null);
  } finally {
    invoiceRepository.findDocumentByInvoiceNumber = originalFindDocumentByInvoiceNumber;
    orderSnapshotService.getInvoiceSnapshot = originalGetInvoiceSnapshot;
  }
});

test('paid invoice creation relabels non-MMK source/payment currencies to MMK without converting amounts', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  const stored: Array<{ currency: string; subtotal: string; grandTotal: string }> = [];
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    stored.push({ currency: data.currency, subtotal: data.subtotal, grandTotal: data.grandTotal });
    return { id: `invoice-${stored.length}`, currency: data.currency } as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    await withSnapshotDependencies(makeOrderSnapshot('USD'), async () => {
      await new InvoiceService().createInvoiceFromPayment(makePaymentPayload('USD'));
    });
    await withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => {
      await new InvoiceService().createInvoiceFromPayment(makePaymentPayload('USD'));
    });

    assert.equal(stored.length, 2);
    for (const invoice of stored) {
      assert.equal(invoice.currency, 'MMK');
      assert.equal(invoice.subtotal, '100.00');
      assert.equal(invoice.grandTotal, '100.00');
    }
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('repeated paid events use one stable idempotency key and return one invoice', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  const invoicesByKey = new Map<string, { id: string; currency: string }>();
  let insertCount = 0;
  let storedIdempotencyKey: string | undefined;
  let storedGatewayReference: string | null | undefined;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    storedIdempotencyKey = data.idempotencyKey;
    storedGatewayReference = data.paymentGatewayRef;
    const existing = invoicesByKey.get(data.idempotencyKey);
    if (existing) return existing as Awaited<ReturnType<typeof originalCreate>>;
    insertCount += 1;
    const invoice = { id: 'invoice-1', currency: data.currency };
    invoicesByKey.set(data.idempotencyKey, invoice);
    return invoice as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    await withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => {
      const service = new InvoiceService();
      const first = await service.createInvoiceFromPayment(makePaymentPayload('MMK'));
      const second = await service.createInvoiceFromPayment(makePaymentPayload('MMK'));
      assert.equal(first, second);
    });
    assert.equal(insertCount, 1);
    assert.equal(storedIdempotencyKey, 'payment:payment-1');
    assert.equal(storedGatewayReference, 'transaction-1');
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('guest invoice lookup requires the order phone and returns only matching invoices', async () => {
  const originalFindAllByOrderId = invoiceRepository.findAllByOrderId;
  const originalFindDocumentById = invoiceRepository.findDocumentById;
  const invoice = {
    id: 'guest-invoice',
    invoiceNumber: 'INV-GUEST',
    orderId: 'guest-order',
    customerPhone: '+959123456789',
    lineItems: [],
    items: [],
  };
  invoiceRepository.findAllByOrderId = async () => [
    invoice,
    { ...invoice, id: 'other-invoice', invoiceNumber: 'INV-OTHER', customerPhone: '+959987654321' },
  ] as unknown as Awaited<ReturnType<typeof originalFindAllByOrderId>>;
  invoiceRepository.findDocumentById = async (id) => (
    id === invoice.id ? invoice : null
  ) as Awaited<ReturnType<typeof originalFindDocumentById>>;

  try {
    const results = await new InvoiceService().getGuestInvoicesByOrder(
      ' guest-order ',
      '+95 9 123 456 789',
    );
    assert.deepEqual(results.map((result) => result.invoiceNumber), ['INV-GUEST']);
    await assert.rejects(
      new InvoiceService().getGuestInvoicesByOrder('guest-order', ''),
      /Order ID and phone number are required/,
    );
  } finally {
    invoiceRepository.findAllByOrderId = originalFindAllByOrderId;
    invoiceRepository.findDocumentById = originalFindDocumentById;
  }
});

test('guest invoice lookup resolves a checkout ID to its order ID', async () => {
  const originalFindAllByOrderId = invoiceRepository.findAllByOrderId;
  const originalFindDocumentById = invoiceRepository.findDocumentById;
  const originalGetInvoiceSnapshotByCheckoutId = orderSnapshotService.getInvoiceSnapshotByCheckoutId;
  const invoice = {
    id: 'guest-invoice',
    invoiceNumber: 'INV-GUEST',
    orderId: 'actual-order-id',
    customerPhone: '+959123456789',
    lineItems: [],
    items: [],
  };
  const queriedOrderIds: string[] = [];
  invoiceRepository.findAllByOrderId = async (orderId) => {
    queriedOrderIds.push(orderId);
    return [invoice] as unknown as Awaited<ReturnType<typeof originalFindAllByOrderId>>;
  };
  invoiceRepository.findDocumentById = async () => (
    invoice as unknown as Awaited<ReturnType<typeof originalFindDocumentById>>
  );
  orderSnapshotService.getInvoiceSnapshotByCheckoutId = async (checkoutId) => ({
    ...makeOrderSnapshot('MMK'),
    orderId: 'actual-order-id',
    checkoutId,
  });

  try {
    const results = await new InvoiceService().getGuestInvoicesByCheckout(
      'guest-checkout-id',
      '+95 9 123 456 789',
    );

    assert.deepEqual(results.map((result) => result.invoiceNumber), ['INV-GUEST']);
    assert.deepEqual(queriedOrderIds, ['actual-order-id']);
  } finally {
    invoiceRepository.findAllByOrderId = originalFindAllByOrderId;
    invoiceRepository.findDocumentById = originalFindDocumentById;
    orderSnapshotService.getInvoiceSnapshotByCheckoutId = originalGetInvoiceSnapshotByCheckoutId;
  }
});

test('invoice replay skips orders that already have an invoice without fetching a snapshot', async () => {
  const originalFindByOrderId = invoiceRepository.findByOrderId;
  const originalGetInvoiceSnapshot = orderSnapshotService.getInvoiceSnapshot;
  let snapshotLookupCount = 0;
  invoiceRepository.findByOrderId = async () => ({ id: 'existing-invoice' }) as Awaited<ReturnType<typeof originalFindByOrderId>>;
  orderSnapshotService.getInvoiceSnapshot = async () => {
    snapshotLookupCount += 1;
    return makeOrderSnapshot('MMK');
  };

  try {
    const result = await new InvoiceService().replayInvoices(['order-1']);
    assert.equal(result.skipped_existing, 1);
    assert.equal(result.created, 0);
    assert.equal(result.results[0].status, 'ALREADY_EXISTS');
    assert.equal(snapshotLookupCount, 0);
  } finally {
    invoiceRepository.findByOrderId = originalFindByOrderId;
    orderSnapshotService.getInvoiceSnapshot = originalGetInvoiceSnapshot;
  }
});

test('invoice replay creates an eligible invoice from real snapshot data without inventing payment references', async () => {
  const originalFindByOrderId = invoiceRepository.findByOrderId;
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  let createData: Parameters<typeof originalCreate>[0] | undefined;
  invoiceRepository.findByOrderId = async () => null;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    createData = data;
    return { id: 'replayed-invoice', status: data.status } as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    const result = await withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => (
      createInvoiceServiceWithoutPdfGeneration().replayInvoices(['order-1'])
    ));
    assert.equal(result.created, 1);
    assert.equal(result.results[0].status, 'CREATED');
    assert.equal(createData?.customerId, 'customer-1');
    assert.equal(createData?.lineItems[0].name, 'Test product');
    assert.equal(createData?.lineItems[0].imageUrl, 'https://products.example.test/images/test-product.png');
    assert.equal(createData?.paymentGatewayRef, null);
    assert.equal(createData?.idempotencyKey, 'replay:order-1');
    assert.equal(createData?.status, 'PAID');
  } finally {
    invoiceRepository.findByOrderId = originalFindByOrderId;
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('invoice replay skips orders that are ineligible under the order.paid policy', async () => {
  const originalFindByOrderId = invoiceRepository.findByOrderId;
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  let createCount = 0;
  invoiceRepository.findByOrderId = async () => null;
  invoiceRepository.createPaidInvoiceFromPayment = async () => {
    createCount += 1;
    return { id: 'unexpected-invoice' } as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    const result = await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      paymentStatus: 'CANCELLED',
    }, async () => createInvoiceServiceWithoutPdfGeneration().replayInvoices(['order-1']));
    assert.equal(result.skipped_ineligible, 1);
    assert.equal(result.created, 0);
    assert.equal(result.results[0].status, 'INELIGIBLE');
    assert.match(result.results[0].reason ?? '', /not eligible/);
    assert.equal(createCount, 0);
  } finally {
    invoiceRepository.findByOrderId = originalFindByOrderId;
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('invoice replay applies the existing unpaid COD invoice policy', async () => {
  const originalFindByOrderId = invoiceRepository.findByOrderId;
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  let storedStatus: string | undefined;
  let storedMethod: string | null | undefined;
  invoiceRepository.findByOrderId = async () => null;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    storedStatus = data.status;
    storedMethod = data.paymentMethod;
    return { id: 'replayed-cod-invoice' } as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    const result = await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      paymentStatus: 'COD',
      paymentMethod: 'cod',
    }, async () => createInvoiceServiceWithoutPdfGeneration().replayInvoices(['order-1']));
    assert.equal(result.created, 1);
    assert.equal(storedStatus, 'UNPAID');
    assert.equal(storedMethod, 'COD');
  } finally {
    invoiceRepository.findByOrderId = originalFindByOrderId;
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('invoice replay records a snapshot failure and continues processing later orders', async () => {
  const originalFindByOrderId = invoiceRepository.findByOrderId;
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  const originalGetInvoiceSnapshot = orderSnapshotService.getInvoiceSnapshot;
  invoiceRepository.findByOrderId = async () => null;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => (
    { id: `invoice-${data.orderId}` } as Awaited<ReturnType<typeof originalCreate>>
  );
  orderSnapshotService.getInvoiceSnapshot = async (orderId) => {
    if (orderId === 'order-fails') throw new Error('snapshot unavailable');
    return { ...makeOrderSnapshot('MMK'), orderId };
  };

  try {
    const result = await createInvoiceServiceWithoutPdfGeneration()
      .replayInvoices(['order-fails', 'order-succeeds']);
    assert.equal(result.failed, 1);
    assert.equal(result.created, 1);
    assert.deepEqual(result.results.map(({ status }) => status), ['FAILED', 'CREATED']);
  } finally {
    invoiceRepository.findByOrderId = originalFindByOrderId;
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
    orderSnapshotService.getInvoiceSnapshot = originalGetInvoiceSnapshot;
  }
});

test('repeated invoice replay skips the invoice created by the first execution', async () => {
  const originalFindByOrderId = invoiceRepository.findByOrderId;
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  const invoicesByOrder = new Map<string, { id: string }>();
  let createCount = 0;
  invoiceRepository.findByOrderId = async (orderId) => (
    invoicesByOrder.get(orderId) as Awaited<ReturnType<typeof originalFindByOrderId>> ?? null
  );
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    createCount += 1;
    const invoice = { id: `invoice-${data.orderId}` };
    invoicesByOrder.set(data.orderId, invoice);
    return invoice as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    const first = await withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => (
      createInvoiceServiceWithoutPdfGeneration().replayInvoices(['order-1'])
    ));
    const second = await withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => (
      createInvoiceServiceWithoutPdfGeneration().replayInvoices(['order-1'])
    ));
    assert.equal(first.created, 1);
    assert.equal(second.skipped_existing, 1);
    assert.equal(createCount, 1);
  } finally {
    invoiceRepository.findByOrderId = originalFindByOrderId;
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('invoice replay enforces the maximum order ID batch size', async () => {
  await assert.rejects(
    new InvoiceService().replayInvoices(Array.from({ length: 51 }, (_, index) => `order-${index}`)),
    /between 1 and 50 order IDs/,
  );
});

test('missing invoice discovery finds an uninvoiced shop when another shop invoice exists', async () => {
  const originalCandidates = orderSnapshotService.getInvoiceCandidates;
  const originalFindPairs = invoiceRepository.findInvoiceShopPairsByOrderIds;
  const originalGetShopName = shopLookupService.getShopName;
  const multiShopSnapshot: OrderInvoiceSnapshot = {
    ...makeOrderSnapshot('MMK'),
    subtotal: '200.00',
    grandTotal: '200.00',
    items: [
      { ...makeOrderSnapshot('MMK').items[0], shopId: 'shop-1', shopName: 'Shop One' },
      {
        ...makeOrderSnapshot('MMK').items[0],
        orderItemId: 'order-item-2',
        productId: 'product-2',
        productName: 'Second product',
        shopId: 'shop-2',
        shopName: null,
      },
    ],
  };
  orderSnapshotService.getInvoiceCandidates = async () => ({
    orders: [{ snapshot: multiShopSnapshot, createdAt: '2026-01-01T00:00:00.000Z', cursorAfter: 'cursor-1' }],
    nextCursor: null,
  });
  invoiceRepository.findInvoiceShopPairsByOrderIds = async () => [{ orderId: 'order-1', shopId: 'shop-1' }];
  shopLookupService.getShopName = async (shopId) => (
    shopId === 'shop-2' ? 'Resolved Shop Two' : null
  );

  try {
    const result = await new InvoiceService().getMissingInvoices();
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].missingShops.length, 1);
    assert.equal(result.data[0].missingShops[0].shopId, 'shop-2');
    assert.equal(result.data[0].missingShops[0].shopName, 'Resolved Shop Two');
    assert.equal(result.data[0].missingShops[0].reason, 'NO_INVOICE_FOR_SHOP');
    assert.equal(result.hasMore, false);
  } finally {
    orderSnapshotService.getInvoiceCandidates = originalCandidates;
    invoiceRepository.findInvoiceShopPairsByOrderIds = originalFindPairs;
    shopLookupService.getShopName = originalGetShopName;
  }
});

test('targeted missing invoice replay follows COD policy and is idempotent per shop', async () => {
  const originalFindByOrderIdAndShopId = invoiceRepository.findByOrderIdAndShopId;
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  const invoicesByShop = new Map<string, { id: string }>();
  const createdShopIds: string[] = [];
  let storedStatus: string | undefined;
  let storedPaymentMethod: string | null | undefined;
  invoiceRepository.findByOrderIdAndShopId = async (_orderId, shopId) => (
    invoicesByShop.get(shopId) as Awaited<ReturnType<typeof originalFindByOrderIdAndShopId>> ?? null
  );
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    createdShopIds.push(data.shopId);
    storedStatus = data.status;
    storedPaymentMethod = data.paymentMethod;
    const invoice = { id: `invoice-${data.shopId}` };
    invoicesByShop.set(data.shopId, invoice);
    return invoice as Awaited<ReturnType<typeof originalCreate>>;
  };

  const snapshot = {
    ...makeOrderSnapshot('MMK'),
    paymentStatus: 'COD',
    paymentMethod: 'COD',
    subtotal: '200.00',
    grandTotal: '200.00',
    items: [
      { ...makeOrderSnapshot('MMK').items[0], shopId: 'shop-1' },
      { ...makeOrderSnapshot('MMK').items[0], orderItemId: 'order-item-2', shopId: 'shop-2' },
    ],
  };

  try {
    const service = createInvoiceServiceWithoutPdfGeneration();
    const first = await withSnapshotDependencies(snapshot, () => service.replayMissingInvoice('order-1', 'shop-2'));
    const second = await withSnapshotDependencies(snapshot, () => service.replayMissingInvoice('order-1', 'shop-2'));
    assert.equal(first.status, 'CREATED');
    assert.equal(second.status, 'ALREADY_EXISTS');
    assert.deepEqual(createdShopIds, ['shop-2']);
    assert.equal(storedStatus, 'UNPAID');
    assert.equal(storedPaymentMethod, 'COD');
  } finally {
    invoiceRepository.findByOrderIdAndShopId = originalFindByOrderIdAndShopId;
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('replay-all creates only missing shop invoices and continues after a candidate failure', async () => {
  const originalCandidates = orderSnapshotService.getInvoiceCandidates;
  const originalFindPairs = invoiceRepository.findInvoiceShopPairsByOrderIds;
  const originalFindByOrderIdAndShopId = invoiceRepository.findByOrderIdAndShopId;
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  const candidateSnapshot = (orderId: string, shopId: string | null): OrderInvoiceSnapshot => ({
    ...makeOrderSnapshot('MMK'),
    orderId,
    items: [{ ...makeOrderSnapshot('MMK').items[0], orderItemId: `${orderId}-item`, shopId }],
  });
  const candidates = [
    { snapshot: candidateSnapshot('bad-order', null), createdAt: '2026-01-01T00:00:00.000Z', cursorAfter: 'cursor-1' },
    { snapshot: candidateSnapshot('good-order', 'shop-2'), createdAt: '2026-01-02T00:00:00.000Z', cursorAfter: 'cursor-2' },
  ];
  const invoicesByShop = new Map<string, { id: string }>();
  const createdOrderIds: string[] = [];
  orderSnapshotService.getInvoiceCandidates = async () => ({ orders: candidates, nextCursor: null });
  invoiceRepository.findInvoiceShopPairsByOrderIds = async () => [];
  invoiceRepository.findByOrderIdAndShopId = async (_orderId, shopId) => (
    invoicesByShop.get(shopId) as Awaited<ReturnType<typeof originalFindByOrderIdAndShopId>> ?? null
  );
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
    createdOrderIds.push(data.orderId);
    const invoice = { id: `invoice-${data.orderId}` };
    invoicesByShop.set(data.shopId, invoice);
    return invoice as Awaited<ReturnType<typeof originalCreate>>;
  };

  try {
    const result = await withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => (
      createInvoiceServiceWithoutPdfGeneration().replayAllMissingInvoices()
    ));
    assert.equal(result.created, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(createdOrderIds, ['good-order']);
    assert.deepEqual(result.results.map(({ status }) => status), ['FAILED', 'CREATED']);
  } finally {
    orderSnapshotService.getInvoiceCandidates = originalCandidates;
    invoiceRepository.findInvoiceShopPairsByOrderIds = originalFindPairs;
    invoiceRepository.findByOrderIdAndShopId = originalFindByOrderIdAndShopId;
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('customer invoice lists read replay-created invoices from invoice-service storage', async () => {
  const originalListInvoices = invoiceRepository.listInvoices;
  const historicalInvoice = { id: 'historical-invoice', orderId: 'order-1' };
  invoiceRepository.listInvoices = async (filters) => {
    assert.equal(filters?.customerId, 'customer-1');
    return [historicalInvoice] as Awaited<ReturnType<typeof originalListInvoices>>;
  };

  try {
    const invoices = await new InvoiceService().getInvoicesByCustomer('customer-1');
    assert.deepEqual(invoices, [historicalInvoice]);
  } finally {
    invoiceRepository.listInvoices = originalListInvoices;
  }
});

test('invoice snapshot update mutation APIs are removed', () => {
  assert.equal('updateOrderSnapshot' in new InvoiceService(), false);
  assert.equal('updateOrderSnapshot' in new InvoiceRepository(), false);
  assert.equal('createInvoice' in new InvoiceRepository(), false);
});

test('partial invoice creation stores MMK even when the snapshot currency is not MMK', async () => {
  const originalFindIdempotency = invoiceRepository.findIdempotency;
  const originalCreatePartialInvoice = invoiceRepository.createPartialInvoice;
  const storedCurrencies: string[] = [];
  invoiceRepository.findIdempotency = async () => null;
  invoiceRepository.createPartialInvoice = async (data) => {
    storedCurrencies.push(data.currency);
    return { id: 'partial-invoice-1', currency: data.currency } as Awaited<ReturnType<typeof originalCreatePartialInvoice>>;
  };

  try {
    await withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => {
      await new InvoiceService().createPartialInvoice({
        orderId: 'order-1',
        items: [{ orderItemId: 'order-item-1', quantity: 1 }],
      }, 'customer-1', 'partial-key');
    });

    await withSnapshotDependencies(makeOrderSnapshot('USD'), async () => {
      await new InvoiceService().createPartialInvoice({
        orderId: 'order-1',
        items: [{ orderItemId: 'order-item-1', quantity: 1 }],
      }, 'customer-1', 'partial-usd-key');
    });

    assert.deepEqual(storedCurrencies, ['MMK', 'MMK']);
  } finally {
    invoiceRepository.findIdempotency = originalFindIdempotency;
    invoiceRepository.createPartialInvoice = originalCreatePartialInvoice;
  }
});

test('validatePartialInvoiceShopSelection rejects mixed-shop selections', () => {
  assert.throws(
    () => validatePartialInvoiceShopSelection(new Set(['shop-1', 'shop-2'])),
    /must belong to one shop/,
  );
});

test('normalizePartialInvoiceRequest sorts items canonically before hashing', () => {
  const request = {
    orderId: 'order-123',
    items: [
      { orderItemId: 'b', quantity: 2 },
      { orderItemId: 'a', quantity: 1 },
    ],
    customerName: '  Jane Doe  ',
    customerEmail: ' Jane@Example.com ',
    paymentMethod: ' manual_slip ',
  };

  const normalized = normalizePartialInvoiceRequest(request);

  assert.deepEqual(
    normalized.items.map((item: { orderItemId: string }) => item.orderItemId),
    ['a', 'b'],
  );
  assert.equal(normalized.customerName, 'Jane Doe');
  assert.equal(normalized.customerEmail, 'jane@example.com');
  assert.equal(normalized.paymentMethod, 'MANUAL_SLIP');
});

test('buildPartialInvoiceRequestHash is stable for equivalent item ordering', () => {
  const requestA = {
    orderId: 'order-123',
    items: [
      { orderItemId: 'b', quantity: 2 },
      { orderItemId: 'a', quantity: 1 },
    ],
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    paymentMethod: 'MANUAL_SLIP',
  };

  const requestB = {
    orderId: 'order-123',
    items: [
      { orderItemId: 'a', quantity: 1 },
      { orderItemId: 'b', quantity: 2 },
    ],
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    paymentMethod: 'MANUAL_SLIP',
  };

  assert.equal(buildPartialInvoiceRequestHash(requestA), buildPartialInvoiceRequestHash(requestB));
});

test('validatePartialInvoiceRequest rejects invalid duplicate or nonpositive item requests', () => {
  assert.throws(() => {
    validatePartialInvoiceRequest({
      orderId: 'order-123',
      items: [
        { orderItemId: 'a', quantity: 2 },
        { orderItemId: 'a', quantity: 1 },
      ],
    });
  });

  assert.throws(() => {
    validatePartialInvoiceRequest({
      orderId: 'order-123',
      items: [{ orderItemId: 'b', quantity: 0 }],
    });
  });
});

test('allocateShopTotals distributes charges across shops and reconciles totals', () => {
  const totals = allocateShopTotals('100.00', '10.00', '5.00', [
    { shopId: 'shop-a', subtotal: '60.00' },
    { shopId: 'shop-b', subtotal: '40.00' },
  ]);

  assert.deepEqual(totals, [
    {
      shopId: 'shop-a',
      subtotal: '60.00',
      deliveryFee: '6.00',
      discountAmount: '3.00',
      grandTotal: '63.00',
    },
    {
      shopId: 'shop-b',
      subtotal: '40.00',
      deliveryFee: '4.00',
      discountAmount: '2.00',
      grandTotal: '42.00',
    },
  ]);
});

test('allocateShopTotals assigns rounding remainder to the final shop', () => {
  const totals = allocateShopTotals('100.00', '1.00', '0.00', [
    { shopId: 'shop-a', subtotal: '33.33' },
    { shopId: 'shop-b', subtotal: '66.67' },
  ]);

  assert.equal(totals[0].deliveryFee, '0.33');
  assert.equal(totals[1].deliveryFee, '0.67');
});

test('calculateShopSubtotal formats minor units before allocating multi-shop invoices', () => {
  const shops = [
    { shopId: 'shop-a', item: { unitPrice: '40000.00', quantity: 1 } },
    { shopId: 'shop-b', item: { unitPrice: '35000.00', quantity: 1 } },
    { shopId: 'shop-c', item: { unitPrice: '25000.00', quantity: 1 } },
  ];
  const totals = allocateShopTotals(
    '100000.00',
    '0.00',
    '0.00',
    shops.map(({ shopId, item }) => ({
      shopId,
      subtotal: calculateShopSubtotal([item]),
    })),
  );

  assert.deepEqual(totals.map((total) => total.grandTotal), ['40000.00', '35000.00', '25000.00']);
});

test('resolveInvoiceDisplayData prefers actual snapshot names over payload fallback values', () => {
  const result = resolveInvoiceDisplayData({
    snapshotCustomerName: 'Alice Customer',
    payloadCustomerName: 'Fallback Customer',
    snapshotCustomerEmail: 'alice@example.com',
    payloadCustomerEmail: 'fallback@example.com',
    snapshotShopName: 'Snapshot Shop',
    payloadShopName: 'Fallback Shop',
    resolvedShopName: 'Resolved Shop',
  });

  assert.equal(result.customerName, 'Alice Customer');
  assert.equal(result.customerEmail, 'alice@example.com');
  assert.equal(result.shopName, 'Resolved Shop');
});

test('resolveInvoiceShopNames resolves distinct shop IDs from the shop lookup', async () => {
  const lookupCalls: string[] = [];
  const names = await resolveInvoiceShopNames(
    ['shop-a', 'shop-b', 'shop-a'],
    async (shopId) => {
      lookupCalls.push(shopId);
      return shopId === 'shop-a' ? 'Main Store' : 'Outlet Store';
    },
  );

  assert.deepEqual(lookupCalls.sort(), ['shop-a', 'shop-b']);
  assert.equal(names.get('shop-a'), 'Main Store');
  assert.equal(names.get('shop-b'), 'Outlet Store');
});

test('populateMissingInvoiceShopNames fills legacy invoices and preserves saved names', async () => {
  const lookupCalls: string[] = [];
  const invoices = await populateMissingInvoiceShopNames(
    [
      { shopId: 'shop-a', shopName: null, invoiceNumber: 'INV-A' },
      { shopId: 'shop-b', shopName: null, invoiceNumber: 'INV-B' },
      { shopId: 'shop-a', shopName: 'Saved Store Name', invoiceNumber: 'INV-C' },
    ],
    async (shopId) => {
      lookupCalls.push(shopId);
      return shopId === 'shop-a' ? 'Main Store' : 'Outlet Store';
    },
  );

  assert.deepEqual(lookupCalls, ['shop-a', 'shop-b']);
  assert.deepEqual(invoices.map((invoice) => invoice.shopName), [
    'Main Store',
    'Outlet Store',
    'Saved Store Name',
  ]);
});

// --- Receipt issuance on legitimate PAID transitions -------------------------
// `withSnapshotDependencies` stubs receipt issuance as a no-op before invoking
// `run()`, so these tests install their recorder inside `run()`. The helper's
// `finally` then restores the real method automatically.

const installReceiptRecorder = (): Array<{ id: string; status?: string }> => {
  const calls: Array<{ id: string; status?: string }> = [];
  receiptService.issueForInvoice = async (invoice) => {
    calls.push({ id: invoice.id, status: invoice.status });
    return null;
  };
  return calls;
};

test('online payment invoice creation from order.paid issues a receipt for the PAID invoice', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => ({
    id: 'invoice-paid',
    status: data.status,
  }) as Awaited<ReturnType<typeof originalCreate>>;

  try {
    await withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => {
      const calls = installReceiptRecorder();
      await new InvoiceService().createInvoiceFromPayment(makePaymentPayload('MMK'));
      assert.deepEqual(calls, [{ id: 'invoice-paid', status: 'PAID' }]);
    });
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('COD invoice creation alone issues no receipt', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => ({
    id: 'invoice-cod',
    status: data.status,
  }) as Awaited<ReturnType<typeof originalCreate>>;

  try {
    await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      paymentStatus: 'COD',
      paymentMethod: 'cod',
    }, async () => {
      const calls = installReceiptRecorder();
      await new InvoiceService().createInvoiceFromPayment({
        ...makePaymentPayload('MMK'),
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
      });
      assert.deepEqual(calls, [], 'COD invoice creation must not issue a receipt');
    });
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

test('COD collection (payment.collected) issues a receipt on the collected invoice', async () => {
  const originalFindAll = invoiceRepository.findAllByOrderId;
  const originalMarkCollected = invoiceRepository.markCollected;
  let collected = false;
  invoiceRepository.findAllByOrderId = async () => [{
    id: 'invoice-cod',
    paymentMethod: 'COD',
    paymentGatewayRef: collected ? 'payment-1' : null,
    status: collected ? 'PAID' : 'UNPAID',
  }] as Awaited<ReturnType<typeof originalFindAll>>;
  invoiceRepository.markCollected = async (id, paymentGatewayRef) => {
    collected = true;
    return { id, status: 'PAID', paymentGatewayRef } as Awaited<ReturnType<typeof originalMarkCollected>>;
  };

  try {
    await withSnapshotDependencies({
      ...makeOrderSnapshot('MMK'),
      paymentStatus: 'COD',
      paymentMethod: 'COD',
    }, async () => {
      const calls = installReceiptRecorder();
      await new InvoiceService().createInvoiceFromPayment({
        ...makePaymentPayload('MMK'),
        transactionId: 'payment-1',
        paymentStatus: 'COLLECTED',
        paymentMethod: 'COD',
      });
      assert.ok(calls.length >= 1, 'COD collection must issue a receipt');
      assert.ok(
        calls.every((call) => call.id === 'invoice-cod' && call.status === 'PAID'),
        'every issuance targets the collected PAID invoice (repository dedupes to one receipt)',
      );
    });
  } finally {
    invoiceRepository.findAllByOrderId = originalFindAll;
    invoiceRepository.markCollected = originalMarkCollected;
  }
});

test('approved slip verification issues a receipt; rejection does not', async () => {
  const originalFindById = invoiceRepository.findById;
  const originalTransition = invoiceRepository.transitionVerification;
  const originalIssue = receiptService.issueForInvoice;
  const service = new InvoiceService();
  Object.defineProperty(service, 'generatePdfAsync', { value: async () => false });
  const calls: Array<{ id: string; status?: string }> = [];
  receiptService.issueForInvoice = async (invoice) => {
    calls.push({ id: invoice.id, status: invoice.status });
    return null;
  };

  try {
    // Approved: PENDING_VERIFICATION → PAID.
    invoiceRepository.findById = async () => ({
      id: 'invoice-slip',
      status: 'PENDING_VERIFICATION',
      shopId: 'shop-1',
    }) as Awaited<ReturnType<typeof originalFindById>>;
    invoiceRepository.transitionVerification = async (id, approved) => ({
      id,
      status: approved ? 'PAID' : 'REJECTED',
      shopId: 'shop-1',
    }) as Awaited<ReturnType<typeof originalTransition>>;

    await service.verifyInvoice('invoice-slip', true, 'admin-1');
    assert.deepEqual(calls, [{ id: 'invoice-slip', status: 'PAID' }]);

    // Rejected: no receipt issuance.
    calls.length = 0;
    await service.verifyInvoice('invoice-slip', false, 'admin-1', 'bad slip');
    assert.deepEqual(calls, [], 'rejected verification must not issue a receipt');
  } finally {
    receiptService.issueForInvoice = originalIssue;
    invoiceRepository.findById = originalFindById;
    invoiceRepository.transitionVerification = originalTransition;
  }
});

test('voiding and refunding an invoice updates the existing receipt status', async () => {
  const originalFindById = invoiceRepository.findById;
  const originalUpdateStatus = invoiceRepository.updateStatus;
  const originalUpdate = receiptService.updateReceiptStatus;
  const updates: Array<{ invoiceId: string; status: string }> = [];
  receiptService.updateReceiptStatus = async (invoiceId, status) => {
    updates.push({ invoiceId, status });
    return null;
  };
  const service = new InvoiceService();
  Object.defineProperty(service, 'generatePdfAsync', { value: async () => false });

  invoiceRepository.findById = async () => ({
    id: 'invoice-1',
    status: 'PAID',
    grandTotal: new Prisma.Decimal('105.00'),
  }) as Awaited<ReturnType<typeof originalFindById>>;
  invoiceRepository.updateStatus = async (id, data) => ({
    id,
    status: data.status,
    grandTotal: new Prisma.Decimal('105.00'),
  }) as Awaited<ReturnType<typeof originalUpdateStatus>>;

  try {
    await service.voidInvoice('invoice-1', 'admin-1', 'cancelled by admin');
    await service.refundInvoice('invoice-1', 'admin-1', '105.00', 'BANK_TRANSFER', 'customer request');
    assert.deepEqual(updates, [
      { invoiceId: 'invoice-1', status: 'VOID' },
      { invoiceId: 'invoice-1', status: 'REFUNDED' },
    ]);
  } finally {
    receiptService.updateReceiptStatus = originalUpdate;
    invoiceRepository.findById = originalFindById;
    invoiceRepository.updateStatus = originalUpdateStatus;
  }
});

test('receipt issuance errors propagate instead of being silently swallowed', async () => {
  const originalCreate = invoiceRepository.createPaidInvoiceFromPayment;
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => ({
    id: 'invoice-paid',
    status: data.status,
  }) as Awaited<ReturnType<typeof originalCreate>>;

  try {
    await assert.rejects(
      withSnapshotDependencies(makeOrderSnapshot('MMK'), async () => {
        // Override the helper's no-op after it is installed, mirroring a
        // repository failure inside the real issuance path.
        receiptService.issueForInvoice = async () => {
          throw new Error('receipt persistence failed');
        };
        await new InvoiceService().createInvoiceFromPayment(makePaymentPayload('MMK'));
      }),
      /receipt persistence failed/,
    );
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
  }
});

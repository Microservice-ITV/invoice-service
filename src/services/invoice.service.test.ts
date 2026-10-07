import assert from 'node:assert/strict';
import test from 'node:test';

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
import orderSnapshotService, { OrderInvoiceSnapshot } from '@/services/order-snapshot.service';
import shopLookupService from '@/services/shop-lookup.service';

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
    hasCurrentInvoicePdf('invoice-pdfs/shop-1/react-print-v13/invoice.pdf'),
    true,
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

const withSnapshotDependencies = async <T>(
  snapshot: OrderInvoiceSnapshot,
  run: () => Promise<T>,
): Promise<T> => {
  const originalGetInvoiceSnapshot = orderSnapshotService.getInvoiceSnapshot;
  const originalGetShopInvoiceSnapshot = shopLookupService.getShopInvoiceSnapshot;
  const originalClaimPdfGeneration = invoiceRepository.claimPdfGeneration;
  orderSnapshotService.getInvoiceSnapshot = async () => snapshot;
  shopLookupService.getShopInvoiceSnapshot = async () => ({
    name: 'Shop One',
    contactName: 'Seller One',
    contactEmail: 'seller@example.com',
    contactPhone: '555-0101',
    address: 'Shop address',
  });
  invoiceRepository.claimPdfGeneration = async () => false;

  try {
    return await run();
  } finally {
    orderSnapshotService.getInvoiceSnapshot = originalGetInvoiceSnapshot;
    shopLookupService.getShopInvoiceSnapshot = originalGetShopInvoiceSnapshot;
    invoiceRepository.claimPdfGeneration = originalClaimPdfGeneration;
  }
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
  invoiceRepository.createPaidInvoiceFromPayment = async (data) => {
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
  } finally {
    invoiceRepository.createPaidInvoiceFromPayment = originalCreate;
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

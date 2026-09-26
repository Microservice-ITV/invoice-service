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
  normalizePartialInvoiceRequest,
  populateMissingInvoiceShopNames,
  resolveInvoiceDisplayData,
  resolveInvoiceShopNames,
  validatePartialInvoiceShopSelection,
  validatePartialInvoiceRequest,
  validateRequestedQuantity,
} from '@/services/invoice.service';

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

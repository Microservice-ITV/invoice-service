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
  normalizePartialInvoiceRequest,
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

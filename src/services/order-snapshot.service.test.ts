import assert from 'node:assert/strict';
import test from 'node:test';
import orderSnapshotService, { OrderSnapshotError } from './order-snapshot.service';

const makeResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('invoice snapshot errors expose useful safe upstream status and 404 reason', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse(404, { message: 'Order not found' });

  try {
    await assert.rejects(
      orderSnapshotService.getInvoiceSnapshot('order-missing'),
      (error: unknown) => {
        assert.ok(error instanceof OrderSnapshotError);
        assert.equal(error.statusCode, 404);
        assert.equal(error.message, 'Order Service invoice snapshot returned 404: Order not found');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invoice snapshot errors do not expose secret-bearing upstream messages', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse(404, { message: 'token invalid: secret-value' });

  try {
    await assert.rejects(
      orderSnapshotService.getInvoiceSnapshot('order-missing'),
      (error: unknown) => {
        assert.ok(error instanceof OrderSnapshotError);
        assert.equal(error.message, 'Order Service invoice snapshot returned 404');
        assert.doesNotMatch(error.message, /token|secret/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invoice snapshot errors omit internal 5xx response bodies', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse(500, { message: 'Database password invalid' });

  try {
    await assert.rejects(
      orderSnapshotService.getInvoiceSnapshot('order-error'),
      (error: unknown) => {
        assert.ok(error instanceof OrderSnapshotError);
        assert.equal(error.message, 'Order Service invoice snapshot returned 500');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invoice snapshots can be resolved by checkout ID', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return makeResponse(200, {
      orderId: 'actual-order-id',
      checkoutId: 'guest-checkout-id',
      customerId: 'guest-customer-id',
      items: [],
      currency: 'MMK',
      subtotal: '0.00',
      deliveryFee: '0.00',
      promotionDiscountTotal: '0.00',
      grandTotal: '0.00',
    });
  };

  try {
    const snapshot = await orderSnapshotService.getInvoiceSnapshotByCheckoutId('guest-checkout-id');

    assert.equal(snapshot.orderId, 'actual-order-id');
    assert.equal(snapshot.checkoutId, 'guest-checkout-id');
    assert.match(requestedUrl, /\/internal\/orders\/checkouts\/guest-checkout-id\/invoice-snapshot$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

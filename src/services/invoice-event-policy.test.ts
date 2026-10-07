import assert from 'node:assert/strict';
import test from 'node:test';
import { getFinalInvoicePaymentStatus } from './invoice-event-policy';

test('prepaid order-paid events issue a paid invoice', () => {
  assert.equal(getFinalInvoicePaymentStatus('order.paid', { payment_status: 'PAID' }), 'PAID');
  assert.equal(getFinalInvoicePaymentStatus('order.paid', {}), null);
});

test('COD order-paid events issue an unpaid invoice immediately', () => {
  assert.equal(getFinalInvoicePaymentStatus('order.paid', { payment_status: 'COD' }), 'UNPAID');
});

test('payment authorization events never make a COD invoice eligible', () => {
  assert.equal(
    getFinalInvoicePaymentStatus('payment.completed', { payment_method: 'cod' }),
    null,
  );
});

test('COD collection marks the existing invoice as collected', () => {
  assert.equal(
    getFinalInvoicePaymentStatus('payment.collected', { payment_method: 'cod' }),
    'COLLECTED',
  );
  assert.equal(
    getFinalInvoicePaymentStatus('payment.collected', { payment_method: 'card' }),
    null,
  );
});
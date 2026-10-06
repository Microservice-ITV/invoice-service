import assert from 'node:assert/strict';
import test from 'node:test';
import { getFinalInvoicePaymentStatus } from './invoice-event-policy';

test('only final non-COD order-paid events are invoice eligible', () => {
  assert.equal(getFinalInvoicePaymentStatus('order.paid', { payment_status: 'PAID' }), 'PAID');
  assert.equal(getFinalInvoicePaymentStatus('order.paid', { payment_status: 'COD' }), null);
  assert.equal(getFinalInvoicePaymentStatus('order.paid', {}), null);
});

test('payment authorization events never make a COD invoice eligible', () => {
  assert.equal(
    getFinalInvoicePaymentStatus('payment.completed', { payment_method: 'cod' }),
    null,
  );
});

test('COD becomes invoice eligible only after payment collection', () => {
  assert.equal(
    getFinalInvoicePaymentStatus('payment.collected', { payment_method: 'cod' }),
    'COLLECTED',
  );
  assert.equal(
    getFinalInvoicePaymentStatus('payment.collected', { payment_method: 'card' }),
    null,
  );
});
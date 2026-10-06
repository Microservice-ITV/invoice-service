import assert from 'node:assert/strict';
import test from 'node:test';
import { canAccessInvoice } from './invoice-access-policy';

const invoice = { customerId: 'customer-a', shopId: 'shop-a' };

test('customer can access only their own invoice', () => {
  assert.equal(canAccessInvoice(invoice, { role: 'customer', customerId: 'customer-a' }), true);
  assert.equal(canAccessInvoice(invoice, { role: 'customer', customerId: 'customer-b' }), false);
});

test('seller can access only the selected authorized shop invoice', () => {
  assert.equal(canAccessInvoice(invoice, { role: 'shopAdmin', shopId: 'shop-a' }), true);
  assert.equal(canAccessInvoice(invoice, { role: 'shopAdmin', shopId: 'shop-b' }), false);
  assert.equal(canAccessInvoice(invoice, { role: 'shopAdmin' }), false);
});

test('platform admins may access any invoice', () => {
  assert.equal(canAccessInvoice(invoice, { role: 'admin' }), true);
});
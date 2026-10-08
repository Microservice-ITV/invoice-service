import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mysql://user:pass@localhost:3306/invoice_test';
process.env.SERVICE_API_KEY = 'invoice-service-test-key';
process.env.ORDER_SERVICE_URL = 'http://localhost:8000';
process.env.ORDER_SERVICE_API_KEY = 'order-service-test-key';
process.env.MINIO_ACCESS_KEY = 'minioadmin';
process.env.MINIO_SECRET_KEY = 'minioadmin';

import { buildInvoiceNotificationEvent } from '@/rabbitmq/publishers/invoice-notification.publisher';

const invoice = {
  id: 'invoice-a',
  invoiceNumber: 'DNI-INV-000001',
  orderId: 'order-a',
  shopId: 'shop-a',
  shopName: 'Shop A',
  customerId: 'customer-a',
  customerName: 'Customer A',
  customerEmail: 'customer@example.com',
  invoiceDate: new Date('2026-10-08T10:00:00.000Z'),
  createdAt: new Date('2026-10-08T10:00:00.000Z'),
  paymentMethod: 'COD',
  status: 'UNPAID',
  currency: 'MMK',
  lineItems: [{
    name: 'Shop A product',
    sku: 'SKU-A',
    quantity: 1,
    unitPrice: '100.00',
    total: '100.00',
  }],
  subtotal: { toString: () => '100.00' },
  taxAmount: { toString: () => '0.00' },
  deliveryFee: { toString: () => '10.00' },
  discountAmount: { toString: () => '0.00' },
  grandTotal: { toString: () => '110.00' },
  pdfUrl: 'invoice-pdfs/shop-a/react-print-v15/DNI-INV-000001-123abc.pdf',
};

test('generated invoice event carries the stored invoice and PDF snapshot', () => {
  const event = buildInvoiceNotificationEvent('invoice.generated', invoice);
  assert.equal(event.event_id, 'invoice:invoice-a:generated');
  assert.equal(event.event, 'invoice.generated');
  assert.equal(event.data.invoice_number, 'DNI-INV-000001');
  assert.equal(event.data.order_id, 'order-a');
  assert.equal(event.data.customer_email, 'customer@example.com');
  assert.equal(event.data.shop_name, 'Shop A');
  assert.equal(event.data.payment_method, 'COD');
  assert.equal(event.data.payment_status, 'UNPAID');
  assert.equal(event.data.pdf_url, invoice.pdfUrl);
  assert.deepEqual(event.data.items, invoice.lineItems);
  assert.equal(event.data.grand_total, '110.00');
});

test('PAID event has a distinct stable idempotency key', () => {
  const first = buildInvoiceNotificationEvent('invoice.paid', { ...invoice, status: 'PAID' });
  const duplicate = buildInvoiceNotificationEvent('invoice.paid', { ...invoice, status: 'PAID' });
  assert.equal(first.event_id, 'invoice:invoice-a:paid');
  assert.equal(duplicate.event_id, first.event_id);
  assert.equal(first.data.payment_status, 'PAID');
});

test('each shop invoice notification retains its own invoice and items', () => {
  const shopBInvoice = {
    ...invoice,
    id: 'invoice-b',
    invoiceNumber: 'DNI-INV-000002',
    shopId: 'shop-b',
    shopName: 'Shop B',
    lineItems: [{
      name: 'Shop B product',
      sku: 'SKU-B',
      quantity: 3,
      unitPrice: '25.00',
      total: '75.00',
    }],
  };
  const event = buildInvoiceNotificationEvent('invoice.generated', shopBInvoice);
  assert.equal(event.event_id, 'invoice:invoice-b:generated');
  assert.equal(event.data.shop_id, 'shop-b');
  assert.equal(event.data.shop_name, 'Shop B');
  assert.deepEqual(event.data.items, shopBInvoice.lineItems);
});

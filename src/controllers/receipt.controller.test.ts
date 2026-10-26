import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { ReceiptController } from '@/controllers/receipt.controller';
import invoicePrintTokenService from '@/services/invoice-print-token.service';
import invoiceService from '@/services/invoice.service';
import receiptService from '@/services/receipt.service';

test('receipt print token returns the hydrated invoice document used by the thermal preview', async () => {
  const originalVerify = invoicePrintTokenService.verify;
  const originalGetInvoice = invoiceService.getInvoiceById;
  const originalGetReceipt = receiptService.getReceiptForInvoice;
  const invoice = {
    id: 'invoice-1', invoiceNumber: 'INV-1', customerId: 'customer-1', status: 'PAID',
    shippingAddress: { city: 'Yangon' }, lineItems: [{ name: 'Real item', quantity: 2, total: '20' }],
  };
  const receipt = { id: 'receipt-1', receiptNumber: 'REC-1' } as any;
  invoicePrintTokenService.verify = (() => ({
    sub: 'customer-1', invoiceId: 'invoice-1', invoiceNumber: 'INV-1', role: 'customer',
    document: 'receipt', receiptId: 'receipt-1',
  })) as typeof invoicePrintTokenService.verify;
  invoiceService.getInvoiceById = async () => invoice as any;
  receiptService.getReceiptForInvoice = async () => ({ invoice: { id: 'invoice-1' } as any, receipt } as any);
  const response: Partial<Response> & { body?: unknown; statusCode?: number } = {
    status(code: number) { this.statusCode = code; return this as Response; },
    json(body: unknown) { this.body = body; return this as Response; },
  };

  try {
    await new ReceiptController().getReceiptForPrint({
      params: { invoiceNumber: 'INV-1' }, header: () => 'signed-token',
    } as unknown as Request, response as Response);
    assert.equal(response.statusCode, undefined);
    assert.deepEqual((response.body as any).data.invoice, invoice);
    assert.deepEqual((response.body as any).data.invoice.lineItems, invoice.lineItems);
    assert.equal((response.body as any).data.receipt, receipt);
  } finally {
    invoicePrintTokenService.verify = originalVerify;
    invoiceService.getInvoiceById = originalGetInvoice;
    receiptService.getReceiptForInvoice = originalGetReceipt;
  }
});

test('receipt print token refuses an invoice that is no longer paid', async () => {
  const originalVerify = invoicePrintTokenService.verify;
  const originalGetInvoice = invoiceService.getInvoiceById;
  const originalGetReceipt = receiptService.getReceiptForInvoice;
  invoicePrintTokenService.verify = (() => ({
    sub: 'customer-1', invoiceId: 'invoice-1', invoiceNumber: 'INV-1', role: 'customer',
    document: 'receipt', receiptId: 'receipt-1',
  })) as typeof invoicePrintTokenService.verify;
  invoiceService.getInvoiceById = async () => ({
    id: 'invoice-1', invoiceNumber: 'INV-1', customerId: 'customer-1', status: 'UNPAID',
  } as any);
  let receiptLookupCalled = false;
  receiptService.getReceiptForInvoice = async () => { receiptLookupCalled = true; return null; };
  let statusCode = 0;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json() { return this; },
  };

  try {
    await new ReceiptController().getReceiptForPrint({
      params: { invoiceNumber: 'INV-1' }, header: () => 'signed-token',
    } as unknown as Request, response as unknown as Response);
    assert.equal(statusCode, 404);
    assert.equal(receiptLookupCalled, false);
  } finally {
    invoicePrintTokenService.verify = originalVerify;
    invoiceService.getInvoiceById = originalGetInvoice;
    receiptService.getReceiptForInvoice = originalGetReceipt;
  }
});

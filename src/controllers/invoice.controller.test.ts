import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import invoiceService from '@/services/invoice.service';
import { getThermalInvoiceDownloadFilename, InvoiceController } from './invoice.controller';

test('thermal invoice download uses a stable INV-prefixed filename for either stored number prefix', () => {
  assert.equal(getThermalInvoiceDownloadFilename('INV-20261008-000039', '58mm'), 'INV-20261008-000039-thermal-58mm.pdf');
  assert.equal(getThermalInvoiceDownloadFilename('DNI-INV-20261008-000039', '80mm'), 'INV-20261008-000039-thermal-80mm.pdf');
});

test('thermal invoice response sends the generated PDF with its dynamic attachment filename', async () => {
  const originalDownload = invoiceService.downloadThermalInvoicePdf;
  const pdf = Buffer.from('%PDF-generated-thermal');
  const generatedPdf = {
    invoice: { invoiceNumber: 'DNI-INV-20261008-000039' },
    buffer: pdf,
  } as unknown as Awaited<ReturnType<typeof invoiceService.downloadThermalInvoicePdf>>;
  invoiceService.downloadThermalInvoicePdf = async () => generatedPdf;

  const headers = new Map<string, string>();
  let body: Buffer | undefined;
  const req = { user: { role: 'seller' }, params: { id: 'invoice-id' }, query: { width: '80mm' } } as unknown as Request;
  const res = {
    setHeader(name: string, value: string) { headers.set(name, value); return this; },
    send(value: Buffer) { body = value; return this; },
  } as unknown as Response;

  try {
    await new InvoiceController().downloadThermalInvoicePdf(req, res, (() => undefined) as NextFunction);
  } finally {
    invoiceService.downloadThermalInvoicePdf = originalDownload;
  }

  assert.equal(headers.get('Content-Disposition'), 'attachment; filename="INV-20261008-000039-thermal-80mm.pdf"');
  assert.equal(headers.get('Content-Type'), 'application/pdf');
  assert.equal(body, pdf);
});

test('shop invoice page uses middleware-resolved shop scope and validated page filters', async () => {
  const originalGetPage = invoiceService.getInvoicePage;
  let requestedQuery: unknown;
  let requestedActor: unknown;
  invoiceService.getInvoicePage = async (query, actor) => {
    requestedQuery = query;
    requestedActor = actor;
    return {
      items: [],
      pagination: { page: 2, limit: 20, totalItems: 40, totalPages: 2, hasNextPage: false, hasPreviousPage: true },
      summary: {
        totalItems: 40, totalBilled: '0', paidCount: 0, pendingCount: 0, voidRefundedCount: 0,
        netRevenue: '0', revenueCurrency: 'MMK', statusCounts: {},
      },
      facets: { paymentMethods: [], shops: [] },
    };
  };

  let responseData: unknown;
  const req = {
    user: { role: 'shopAdmin', shopId: 'shop-a', shopIds: ['shop-a', 'shop-b'] },
    query: { status: 'paid', page: '2', limit: '20' },
  } as unknown as Request;
  const res = {
    json(payload: unknown) { responseData = payload; return this; },
  } as Response;

  try {
    await new InvoiceController().getShopInvoices(req, res, (() => undefined) as NextFunction);
  } finally {
    invoiceService.getInvoicePage = originalGetPage;
  }

  assert.deepEqual(requestedQuery, {
    page: 2, limit: 20, sortOrder: 'desc', status: 'PAID', shopIds: ['shop-a', 'shop-b'],
  });
  assert.deepEqual(requestedActor, req.user);
  assert.deepEqual(responseData, {
    success: true,
    data: [],
    pagination: { page: 2, limit: 20, totalItems: 40, totalPages: 2, hasNextPage: false, hasPreviousPage: true },
    summary: {
      totalItems: 40, totalBilled: '0', paidCount: 0, pendingCount: 0, voidRefundedCount: 0,
      netRevenue: '0', revenueCurrency: 'MMK', statusCounts: {},
    },
    facets: { paymentMethods: [], shops: [] },
  });
});

test('admin invoice pages explicitly request the customer fields used by the admin table', async () => {
  const originalGetPage = invoiceService.getInvoicePage;
  let requestedOptions: unknown;
  invoiceService.getInvoicePage = async (_query, _actor, options) => {
    requestedOptions = options;
    return {
      items: [],
      pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
      summary: {
        totalItems: 0, totalBilled: '0', paidCount: 0, pendingCount: 0, voidRefundedCount: 0,
        netRevenue: '0', revenueCurrency: 'MMK', statusCounts: {},
      },
      facets: { paymentMethods: [], shops: [] },
    };
  };
  const req = {
    user: { role: 'admin', id: 'admin-1' },
    query: { page: '1', limit: '20' },
  } as unknown as Request;
  const res = { json() { return this; } } as unknown as Response;

  try {
    await new InvoiceController().getAdminInvoices(req, res, (() => undefined) as NextFunction);
  } finally {
    invoiceService.getInvoicePage = originalGetPage;
  }

  assert.deepEqual(requestedOptions, { includeShops: true, includeCustomerEmail: true });
});

test('invoice list rejects invalid pagination instead of returning an unbounded page', async () => {
  const originalGetPage = invoiceService.getInvoicePage;
  invoiceService.getInvoicePage = async () => {
    assert.fail('invalid pagination must not query the invoice service');
  };
  let statusCode = 0;
  let responseBody: unknown;
  const req = {
    user: { role: 'customer', customerId: 'customer-1' },
    query: { page: '1', limit: '101' },
  } as unknown as Request;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(payload: unknown) { responseBody = payload; return this; },
  } as unknown as Response;

  try {
    await new InvoiceController().getMyInvoices(req, res, (() => undefined) as NextFunction);
  } finally {
    invoiceService.getInvoicePage = originalGetPage;
  }

  assert.equal(statusCode, 400);
  assert.match(JSON.stringify(responseBody), /limit must be between 1 and 100/);
});

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

test('shop invoice listing queries every shop resolved by authorization middleware', async () => {
  const originalListByShops = invoiceService.getInvoicesByShops;
  const originalListByShop = invoiceService.getInvoicesByShop;
  let requestedShopIds: string[] = [];
  invoiceService.getInvoicesByShops = async (shopIds) => {
    requestedShopIds = shopIds;
    return [];
  };
  invoiceService.getInvoicesByShop = async () => {
    assert.fail('single-shop query should not be used when memberships are resolved');
  };

  let responseData: unknown;
  const req = { user: { role: 'shopAdmin', shopId: 'shop-a', shopIds: ['shop-a', 'shop-b'] } } as Request;
  const res = {
    json(payload: unknown) { responseData = payload; return this; },
  } as Response;

  try {
    await new InvoiceController().getShopInvoices(req, res, (() => undefined) as NextFunction);
  } finally {
    invoiceService.getInvoicesByShops = originalListByShops;
    invoiceService.getInvoicesByShop = originalListByShop;
  }

  assert.deepEqual(requestedShopIds, ['shop-a', 'shop-b']);
  assert.deepEqual(responseData, { success: true, data: [] });
});

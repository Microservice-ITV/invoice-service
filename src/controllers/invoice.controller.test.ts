import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import invoiceService from '@/services/invoice.service';
import { InvoiceController } from './invoice.controller';

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

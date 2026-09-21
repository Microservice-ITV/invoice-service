import assert from 'node:assert/strict';
import test from 'node:test';
import router from './index';
import { auth } from '@/middleware/auth';

test('invoice router includes generate-pdf route', () => {
  const stack = (router as { stack?: Array<{ route?: { path?: string } }> }).stack ?? [];
  const hasPdfRoute = stack.some((layer) => layer.route?.path === '/invoices/:id/generate-pdf');

  assert.equal(hasPdfRoute, true);
});

test('customer requests with a shop id stay customer scoped', () => {
  const headers: Record<string, string | undefined> = {
    authorization: 'Bearer demo-token',
    'x-user-role': 'customer',
    'x-shop-id': 'shop-123',
    'x-user-id': 'user-456',
    'x-customer-id': 'customer-789',
  };

  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    originalUrl: '/api/v1/invoices/my-invoices',
    path: '/invoices/my-invoices',
    user: undefined as any,
  } as any;

  const res = {
    status: () => ({
      json: () => undefined,
    }),
    json: () => undefined,
  } as any;

  let nextCalled = false;

  auth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.user.role, 'customer');
});

test('shop-scoped requests without explicit role can still resolve as shop admin', () => {
  const headers: Record<string, string | undefined> = {
    authorization: 'Bearer demo-token',
    'x-shop-id': 'shop-123',
    'x-user-id': 'user-456',
  };

  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    originalUrl: '/api/v1/invoices/shop-invoices',
    path: '/invoices/shop-invoices',
    user: undefined as any,
  } as any;

  const res = {
    status: () => ({
      json: () => undefined,
    }),
    json: () => undefined,
  } as any;

  let nextCalled = false;

  auth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.user.role, 'shopAdmin');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import router from './index';
import env from '@/config/env';
import { auth } from '@/middleware/auth';

env.JWT_SECRET = env.JWT_SECRET ?? 'invoice-service-test-jwt-secret';

const createToken = (userId: string): string =>
  jwt.sign({ sub: userId }, env.JWT_SECRET!, { algorithm: 'HS256' });

test('invoice router includes generate-pdf route', () => {
  const stack = (router as { stack?: Array<{ route?: { path?: string } }> }).stack ?? [];
  const hasPdfRoute = stack.some((layer) => layer.route?.path === '/invoices/:id/generate-pdf');

  assert.equal(hasPdfRoute, true);
});

test('customer requests with a shop id stay customer scoped', async () => {
  const headers: Record<string, string | undefined> = {
    authorization: `Bearer ${createToken('user-456')}`,
    'x-user-role': 'customer',
    'x-shop-id': 'shop-123',
    'x-user-id': 'user-456',
    'x-customer-id': 'customer-789',
  };

  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    originalUrl: '/api/v1/invoices/my-invoices',
    path: '/invoices/my-invoices',
    method: 'GET',
    user: undefined as any,
  } as any;

  const res = {
    status: () => ({
      json: () => undefined,
    }),
    json: () => undefined,
  } as any;

  let nextCalled = false;

  await auth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.user.role, 'customer');
});

test('shop-scoped requests resolve after access context authorizes the shop', async () => {
  const headers: Record<string, string | undefined> = {
    authorization: `Bearer ${createToken('user-456')}`,
    'x-shop-id': 'shop-123',
    'x-user-id': 'user-456',
  };

  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    originalUrl: '/api/v1/invoices/shop-invoices',
    path: '/invoices/shop-invoices',
    method: 'GET',
    user: undefined as any,
  } as any;

  const res = {
    status: () => ({
      json: () => undefined,
    }),
    json: () => undefined,
  } as any;

  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      data: {
        active_shop: { shop_id: 'shop-123', role: { code: 'shop_owner' } },
        shops: [{
          shop_id: 'shop-123',
          membership_status: 'active',
          role: { code: 'shop_owner' },
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  let nextCalled = false;

  try {
    await auth(req, res, () => {
      nextCalled = true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(requestedUrl, /\/api\/v1\/me\/access-context$/);
  assert.equal(nextCalled, true);
  assert.equal(req.user.role, 'shopAdmin');
  assert.equal(req.user.shopId, 'shop-123');
});

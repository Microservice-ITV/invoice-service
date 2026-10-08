import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import router from './index';
import env from '@/config/env';
import { auth } from '@/middleware/auth';
import { serviceAuth } from '@/middleware/serviceAuth';

env.JWT_SECRET = env.JWT_SECRET ?? 'invoice-service-test-jwt-secret';

const createToken = (userId: string): string =>
  jwt.sign({ sub: userId }, env.JWT_SECRET!, { algorithm: 'HS256' });

test('invoice router includes generate-pdf route', () => {
  const stack = (router as { stack?: Array<{ route?: { path?: string } }> }).stack ?? [];
  const hasPdfRoute = stack.some((layer) => layer.route?.path === '/invoices/:id/generate-pdf');

  assert.equal(hasPdfRoute, true);
});

test('invoice replay route is restricted to authenticated admins', () => {
  type RouteTestRequest = { user?: { role?: 'admin' | 'customer' } };
  type RouteTestResponse = {
    status(code: number): RouteTestResponse;
    json(): void;
  };
  type RouteMiddleware = (
    req: RouteTestRequest,
    res: RouteTestResponse,
    next: () => void,
  ) => void;
  type RouteLayer = {
    route?: {
      path?: string;
      methods?: Record<string, boolean>;
      stack?: Array<{ handle: unknown }>;
    };
  };

  const stack = (router as unknown as { stack?: RouteLayer[] }).stack ?? [];
  const replayRoute = stack.find((layer) => layer.route?.path === '/admin/invoices/replay');
  assert.ok(replayRoute);
  assert.equal(replayRoute.route?.methods?.post, true);
  assert.equal(replayRoute.route?.stack?.[0].handle, auth);

  const requireAdmin = replayRoute.route?.stack?.[1].handle as RouteMiddleware;
  let statusCode = 0;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {},
  };
  let nextCalled = false;
  requireAdmin({ user: { role: 'customer' } }, response, () => {
    nextCalled = true;
  });
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);

  requireAdmin({ user: { role: 'admin' } }, response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('missing invoice discovery and replay routes are restricted to authenticated admins', () => {
  const stack = (router as unknown as {
    stack?: Array<{
      route?: {
        path?: string;
        methods?: Record<string, boolean>;
        stack?: Array<{ handle: unknown }>;
      };
    }>;
  }).stack ?? [];
  const protectedPaths = [
    ['/admin/invoices/missing', 'get'],
    ['/admin/invoices/missing/replay', 'post'],
    ['/admin/invoices/missing/replay-all', 'post'],
  ] as const;

  for (const [path, method] of protectedPaths) {
    const route = stack.find((layer) => layer.route?.path === path);
    assert.ok(route, `expected route ${path}`);
    assert.equal(route.route?.methods?.[method], true);
    assert.equal(route.route?.stack?.[0].handle, auth);
    assert.equal(route.route?.stack?.length, 3);
  }
});

test('internal invoice PDF email route requires the invoice service key', () => {
  const stack = (router as unknown as {
    stack?: Array<{
      route?: {
        path?: string;
        methods?: Record<string, boolean>;
        stack?: Array<{ handle: unknown }>;
      };
    }>;
  }).stack ?? [];
  const route = stack.find((layer) => layer.route?.path === '/internal/invoices/:id/email-pdf');

  assert.ok(route);
  assert.equal(route.route?.methods?.get, true);
  assert.equal(route.route?.stack?.[0].handle, serviceAuth);
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

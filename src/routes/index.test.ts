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

test('thermal invoice and receipt PDF routes are registered under the /api/v1 router with auth', () => {
  const stack = (router as unknown as {
    stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean>; stack?: Array<{ handle: unknown }> } }>;
  }).stack ?? [];
  for (const path of ['/invoices/:id/thermal-pdf', '/invoices/:id/receipt/pdf']) {
    const route = stack.find((layer) => layer.route?.path === path);
    assert.ok(route, `expected route ${path}`);
    assert.equal(route.route?.methods?.get, true);
    assert.equal(route.route?.stack?.[0].handle, auth);
  }
});

test('token-authenticated React print data routes are registered for invoice and receipt rendering', () => {
  const stack = (router as unknown as {
    stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean>; stack?: Array<{ handle: unknown }> } }>;
  }).stack ?? [];
  for (const path of ['/invoices/print/:invoiceNumber', '/invoices/print/:invoiceNumber/receipt']) {
    const route = stack.find((layer) => layer.route?.path === path);
    assert.ok(route, `expected route ${path}`);
    assert.equal(route.route?.methods?.get, true);
    // These routes authenticate via a short-lived signed x-print-token in the controller.
    assert.equal(route.route?.stack?.length, 1);
  }
});

test('thermal invoice and receipt PDF routes are mounted under the invoice API with auth', () => {
  const stack = (router as unknown as {
    stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean>; stack?: Array<{ handle: unknown }> } }>;
  }).stack ?? [];
  for (const path of ['/invoices/:id/thermal-pdf', '/invoices/:id/receipt/pdf']) {
    const route = stack.find((layer) => layer.route?.path === path);
    assert.ok(route, `expected registered route ${path}`);
    assert.equal(route.route?.methods?.get, true);
    assert.equal(route.route?.stack?.[0].handle, auth);
  }
});

test('guest invoice lookup is reachable without a registered-user auth middleware', () => {
  const stack = (router as unknown as {
    stack?: Array<{
      route?: {
        path?: string;
        methods?: Record<string, boolean>;
        stack?: Array<{ handle: unknown }>;
      };
    }>;
  }).stack ?? [];
  const route = stack.find((layer) => layer.route?.path === '/invoices/guest/order');

  assert.ok(route);
  assert.equal(route.route?.methods?.post, true);
  assert.equal(route.route?.stack?.length, 1);
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

test('staff invoice listing resolves all active memberships without requiring an active shop', async () => {
  const headers: Record<string, string | undefined> = {
    authorization: `Bearer ${createToken('user-456')}`,
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
        active_shop: null,
        shops: [
          { shop_id: 'shop-a', membership_status: 'active', role: { code: 'shop_owner' } },
          { shop_id: 'shop-b', membership_status: 'active', role: { code: 'shop_admin' } },
          { shop_id: 'shop-inactive', membership_status: 'inactive', role: { code: 'shop_admin' } },
        ],
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
  assert.equal(req.user.shopId, 'shop-a');
  assert.deepEqual(req.user.shopIds, ['shop-a', 'shop-b']);
});

test('staff invoice listing rejects a requested shop outside active memberships', async () => {
  const headers: Record<string, string | undefined> = {
    authorization: `Bearer ${createToken('user-456')}`,
    'x-shop-id': 'shop-outside-membership',
  };
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    originalUrl: '/api/v1/invoices/shop-invoices',
    path: '/invoices/shop-invoices',
    method: 'GET',
  } as any;
  let statusCode = 0;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json() {},
  } as any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: { shops: [{ shop_id: 'shop-a', membership_status: 'active' }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let nextCalled = false;
  try {
    await auth(req, res, () => { nextCalled = true; });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);
});

test('staff invoice detail reads resolve all memberships when no active shop is selected', async () => {
  const headers: Record<string, string | undefined> = {
    authorization: `Bearer ${createToken('staff-user')}`,
    'x-user-role': 'shopAdmin',
  };
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    originalUrl: '/api/v1/invoices/by-number/INV-REAL',
    path: '/invoices/by-number/INV-REAL',
    method: 'GET',
  } as any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      active_shop: null,
      shops: [
        { shop_id: 'shop-a', membership_status: 'active', role: { code: 'staff' } },
        { shop_id: 'shop-b', membership_status: 'active', role: { code: 'staff' } },
      ],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let nextCalled = false;
  try {
    await auth(req, { status() { return this; }, json() {} } as any, () => { nextCalled = true; });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(nextCalled, true);
  assert.equal(req.user.role, 'shopAdmin');
  assert.deepEqual(req.user.shopIds, ['shop-a', 'shop-b']);
});

test('single-shop staff invoice detail resolves the authenticated shop membership', async () => {
  const headers: Record<string, string | undefined> = {
    authorization: `Bearer ${createToken('staff-user')}`,
    'x-user-role': 'shopAdmin',
  };
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    originalUrl: '/api/v1/invoices/by-number/INV-REAL',
    path: '/invoices/by-number/INV-REAL',
    method: 'GET',
  } as any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      active_shop: { shop_id: 'shop-only' },
      shops: [{ shop_id: 'shop-only', membership_status: 'active', role: { code: 'staff' } }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let nextCalled = false;
  try {
    await auth(req, { status() { return this; }, json() {} } as any, () => { nextCalled = true; });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(nextCalled, true);
  assert.equal(req.user.shopId, 'shop-only');
  assert.deepEqual(req.user.shopIds, ['shop-only']);
});

test('staff invoice detail rejects shop context outside verified memberships', async () => {
  const headers: Record<string, string | undefined> = {
    authorization: `Bearer ${createToken('staff-user')}`,
    'x-user-role': 'shopAdmin',
    'x-shop-id': 'shop-outside',
  };
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    originalUrl: '/api/v1/invoices/by-number/INV-REAL',
    path: '/invoices/by-number/INV-REAL',
    method: 'GET',
  } as any;
  let statusCode = 0;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json() {},
  } as any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: { shops: [{ shop_id: 'shop-a', membership_status: 'active', role: { code: 'staff' } }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let nextCalled = false;
  try {
    await auth(req, response, () => { nextCalled = true; });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);
});

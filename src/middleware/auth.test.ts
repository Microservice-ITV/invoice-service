import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectAuthorizedShopIds,
  isCustomerInvoiceByNumberRoute,
  needsOwnedShopLookup,
  parseAccessContextResponse,
  selectAuthorizedShopId,
} from '@/middleware/auth';

test('parseAccessContextResponse unwraps Auth service access_context envelope', () => {
  const context = {
    platform_roles: [],
    active_shop: { shop_id: 'shop-a', role: { code: 'shop_owner' } },
    shops: [
      {
        shop_id: 'shop-a',
        membership_status: 'active',
        role: { code: 'shop_owner' },
      },
    ],
  };

  assert.deepEqual(
    parseAccessContextResponse({
      success: true,
      data: { user: { id: 'user-a' }, access_context: context },
    }),
    context,
  );
});

test('parseAccessContextResponse accepts the legacy flat data shape', () => {
  const context = { shops: [{ shop_id: 'shop-a', membership_status: 'active' }] };

  assert.deepEqual(parseAccessContextResponse({ success: true, data: context }), context);
});

test('parseAccessContextResponse rejects missing or malformed shop context', () => {
  assert.equal(parseAccessContextResponse(null), null);
  assert.equal(parseAccessContextResponse({ success: true, data: {} }), null);
});

test('seller invoice scope combines active memberships and owned shops without duplicates', () => {
  const shopIds = collectAuthorizedShopIds(
    {
      shops: [
        { shop_id: 'member-shop', membership_status: 'active' },
        { shop_id: 'inactive-shop', membership_status: 'inactive' },
        { shop_id: 'owned-shop', membership_status: 'active' },
      ],
    },
    ['owned-shop', 'another-owned-shop'],
  );

  assert.deepEqual(shopIds, ['member-shop', 'owned-shop', 'another-owned-shop']);
});

test('x-shop-id alone cannot authorize an unassigned shop', () => {
  assert.equal(selectAuthorizedShopId('shop-b', undefined, []), null);
  assert.equal(selectAuthorizedShopId('shop-b', 'shop-a', ['shop-a']), null);
  assert.equal(selectAuthorizedShopId('shop-a', 'shop-a', ['shop-a']), 'shop-a');
});

test('verified active shop context avoids the owned-shop service lookup', () => {
  const context = {
    active_shop: { shop_id: 'shop-a' },
    shops: [{ shop_id: 'shop-a', membership_status: 'active' }],
  };

  assert.equal(needsOwnedShopLookup(context, 'shop-a', false), false);
});

test('unassigned shop requests still require the owned-shop service lookup', () => {
  const context = {
    active_shop: { shop_id: 'shop-a' },
    shops: [{ shop_id: 'shop-a', membership_status: 'active' }],
  };

  assert.equal(needsOwnedShopLookup(context, 'shop-b', false), true);
});

test('customer invoice reads with no active shops skip the owned-shop lookup', () => {
  assert.equal(
    needsOwnedShopLookup({ shops: [] }, undefined, true),
    false,
  );
});

test('customer invoice-by-number route recognizes the mounted API path', () => {
  assert.equal(
    isCustomerInvoiceByNumberRoute('/api/v1/invoices/by-number/INV-1', 'customer'),
    true,
  );
  assert.equal(
    isCustomerInvoiceByNumberRoute('/api/v1/invoices/by-number/INV-1', 'shopAdmin'),
    false,
  );
});
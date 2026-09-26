import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccessContextResponse } from '@/middleware/auth';

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
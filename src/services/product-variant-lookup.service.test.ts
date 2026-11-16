import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderInvoiceSnapshotItem } from '@/services/order-snapshot.service';
import { ProductVariantLookupService } from '@/services/product-variant-lookup.service';

const snapshotItem = (orderItemId: string, sku: string): OrderInvoiceSnapshotItem => ({
  orderItemId,
  productId: 'product-1',
  productName: 'Cotton shirt',
  productSku: sku,
  quantity: 1,
  unitPrice: '1000',
  lineTotal: '1000',
  shopId: 'shop-1',
});

test('enriches invoice items from the matching product-service variant SKU', async () => {
  const requestedUrls: string[] = [];
  const service = new ProductVariantLookupService(async (input) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({
      data: {
        variants: [
          {
            sku: 'SHIRT-BLUE-M',
            color: { name: 'Blue', code: 'BLU' },
            size: { name: 'Medium', code: 'M' },
          },
          {
            sku: 'SHIRT-BLACK',
            color: { name: 'Black', code: 'BLK' },
            size: null,
          },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const items = await service.enrich([
    { orderItemId: 'order-item-1', sku: 'SHIRT-BLUE-M', name: 'Cotton shirt', quantity: 1, unitPrice: '1000', total: '1000' },
    { orderItemId: 'order-item-2', sku: 'SHIRT-BLACK', name: 'Cotton shirt', quantity: 1, unitPrice: '1000', total: '1000' },
  ], [
    snapshotItem('order-item-1', 'SHIRT-BLUE-M'),
    snapshotItem('order-item-2', 'SHIRT-BLACK'),
  ]);

  assert.equal(requestedUrls.length, 1, 'a product lookup should be shared by all its line items');
  assert.match(requestedUrls[0], /\/products\/product-1$/);
  assert.equal(items[0].color, 'Blue');
  assert.equal(items[0].size, 'M');
  assert.equal(items[1].color, 'Black');
  assert.equal(items[1].size, null, 'sizes are omitted when the matched variant has no size');
  await service.enrich([
    { orderItemId: 'order-item-1', sku: 'SHIRT-BLUE-M', name: 'Cotton shirt', quantity: 1, unitPrice: '1000', total: '1000' },
  ], [snapshotItem('order-item-1', 'SHIRT-BLUE-M')]);
  assert.equal(requestedUrls.length, 1, 'recent product lookups should be reused across preview and PDF requests');
});

test('uses color and size already included in the real order snapshot before product lookup', async () => {
  let requestCount = 0;
  const service = new ProductVariantLookupService(async () => {
    requestCount += 1;
    throw new Error('snapshot variant data should avoid a product lookup');
  });
  const snapshot = {
    ...snapshotItem('order-item-1', 'SHIRT-BLUE-M'),
    color: 'Blue',
    size: 'Medium',
  };

  const [item] = await service.enrich([{
    orderItemId: 'order-item-1',
    sku: 'SHIRT-BLUE-M',
    name: 'Cotton shirt',
    quantity: 1,
    unitPrice: '1000',
    total: '1000',
  }], [snapshot]);

  assert.equal(item.color, 'Blue');
  assert.equal(item.size, 'Medium');
  assert.equal(requestCount, 0);
});

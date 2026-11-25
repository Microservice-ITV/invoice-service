import assert from 'node:assert/strict';
import test from 'node:test';
import { InvoiceCacheService } from '@/services/invoice-cache.service';

class MemoryCacheStore {
  private readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
    return 'OK';
  }

  async incr(key: string) {
    const value = Number(this.values.get(key) ?? '0') + 1;
    this.values.set(key, String(value));
    return value;
  }
}

test('invoice cache reuses scoped values and invalidation switches generations', async () => {
  const store = new MemoryCacheStore();
  const cache = new InvoiceCacheService(async () => store);
  let loads = 0;
  const load = async () => ({ status: `value-${++loads}` });

  assert.deepEqual(await cache.getOrLoad('customer:one:list:page=1', 30, load), { status: 'value-1' });
  assert.deepEqual(await cache.getOrLoad('customer:one:list:page=1', 30, load), { status: 'value-1' });
  assert.deepEqual(await cache.getOrLoad('customer:two:list:page=1', 30, load), { status: 'value-2' });

  await cache.invalidate();

  assert.deepEqual(await cache.getOrLoad('customer:one:list:page=1', 30, load), { status: 'value-3' });
  assert.equal(loads, 3);
});

test('concurrent cache misses share one database load', async () => {
  const store = new MemoryCacheStore();
  const cache = new InvoiceCacheService(async () => store);
  let loads = 0;
  const load = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return ['invoice'];
  };

  const [first, second] = await Promise.all([
    cache.getOrLoad('shop:one:list:page=1', 30, load),
    cache.getOrLoad('shop:one:list:page=1', 30, load),
  ]);

  assert.deepEqual(first, ['invoice']);
  assert.deepEqual(second, ['invoice']);
  assert.equal(loads, 1);
});

test('Redis provider failures use the database loader', async () => {
  const cache = new InvoiceCacheService(async () => {
    throw new Error('Redis offline');
  });
  let loads = 0;

  const result = await cache.getOrLoad('shop:one:detail:invoice', 60, async () => {
    loads += 1;
    return { id: 'invoice' };
  });

  assert.deepEqual(result, { id: 'invoice' });
  assert.equal(loads, 1);
});

test('generation invalidation failures bypass cached invoice values and reload from the database', async () => {
  const store = new MemoryCacheStore();
  const cache = new InvoiceCacheService(async () => store);
  let loads = 0;

  await cache.getOrLoad('customer:one:detail:invoice-1', 60, async () => ({
    value: `database-${++loads}`,
  }));
  store.incr = async () => {
    throw new Error('Redis generation update failed');
  };

  await cache.invalidate();
  const result = await cache.getOrLoad('customer:one:detail:invoice-1', 60, async () => ({
    value: `database-${++loads}`,
  }));

  assert.deepEqual(result, { value: 'database-2' });
  assert.equal(loads, 2);
});

test('slow cache writes do not delay the database response', async () => {
  const store = new MemoryCacheStore();
  store.set = async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return 'OK';
  };
  const cache = new InvoiceCacheService(async () => store);

  const result = await Promise.race([
    cache.getOrLoad('customer:one:list:page=1', 30, async () => ({ items: ['invoice'] })),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cache write blocked response')), 75)),
  ]);

  assert.deepEqual(result, { items: ['invoice'] });
});

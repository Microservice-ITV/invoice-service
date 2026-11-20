import { createClient } from 'redis';
import env from '@/config/env';
import logger from '@/utils/logger';

const GENERATION_KEY = 'invoice-cache:generation';

type InvoiceCacheStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  incr(key: string): Promise<number>;
};

const redisClient = env.REDIS_URL
  ? createClient({
    url: env.REDIS_URL,
    socket: {
      connectTimeout: 1_000,
      reconnectStrategy: (retries) => (retries < 1 ? 250 : false),
    },
  })
  : null;

redisClient?.on('error', (error) => {
  logger.warn('Invoice Redis client error', { error: error.message });
});

const redisStore: InvoiceCacheStore | null = redisClient
  ? {
    get: (key) => redisClient.get(key),
    set: (key, value, options) => redisClient.set(key, value, options),
    incr: (key) => redisClient.incr(key),
  }
  : null;

let connectionPromise: Promise<boolean> | null = null;
let redisUnavailableUntil = 0;

const getRedisStore = async (): Promise<InvoiceCacheStore | null> => {
  if (!redisClient || !redisStore || Date.now() < redisUnavailableUntil) return null;
  if (redisClient.isReady) return redisStore;
  if (redisClient.isOpen) return null;

  if (!connectionPromise) {
    connectionPromise = redisClient.connect()
      .then(() => redisClient.isReady)
      .catch((error: unknown) => {
        redisUnavailableUntil = Date.now() + 5_000;
        logger.warn('Invoice Redis connection failed; using the database', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      })
      .finally(() => {
        connectionPromise = null;
      });
  }

  const connected = await connectionPromise;
  return connected && redisClient.isReady ? redisStore : null;
};

export class InvoiceCacheService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly storeProvider: () => Promise<InvoiceCacheStore | null> = getRedisStore,
  ) {}

  async getOrLoad<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    let store = await this.getStore();
    let version = '0';

    if (store) {
      try {
        version = (await store.get(GENERATION_KEY)) ?? '0';
        const cached = await store.get(this.keyFor(version, key));
        if (cached !== null) {
          try {
            return JSON.parse(cached) as T;
          } catch (error) {
            logger.warn('Invalid invoice cache value; refreshing from the database', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        logger.warn('Invoice Redis read failed; using the database', {
          error: error instanceof Error ? error.message : String(error),
        });
        store = null;
      }
    }

    const cacheKey = store ? this.keyFor(version, key) : `offline:${key}`;
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending as Promise<T>;

    const request = load().then(async (value) => {
      if (store) {
        try {
          const serialized = JSON.stringify(value);
          if (serialized !== undefined) {
            await store.set(cacheKey, serialized, { EX: ttlSeconds });
          }
        } catch (error) {
          logger.warn('Invoice Redis write failed; returning database result', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return value;
    }).finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, request);
    return request;
  }

  async invalidate(): Promise<void> {
    const store = await this.getStore();
    if (!store) return;
    try {
      await store.incr(GENERATION_KEY);
    } catch (error) {
      logger.warn('Invoice Redis invalidation failed; cached entries will expire by TTL', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close(): Promise<void> {
    if (!redisClient?.isReady) return;
    try {
      await redisClient.quit();
    } catch (error) {
      logger.warn('Invoice Redis shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getStore(): Promise<InvoiceCacheStore | null> {
    try {
      return await this.storeProvider();
    } catch (error) {
      logger.warn('Invoice Redis unavailable; using the database', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private keyFor(version: string, key: string): string {
    return `invoice-cache:${version}:${key}`;
  }
}

export const invoiceCacheService = new InvoiceCacheService();

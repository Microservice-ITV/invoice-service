import env from '@/config/env';

class ShopLookupService {
  async getShopName(shopId: string): Promise<string | null> {
    const internalKey = env.AUTH_SERVICE_INTERNAL_KEY?.trim();
    const lookups: Array<{ url: string; headers: Record<string, string> }> = [
      ...(internalKey ? [{
        url: `${env.AUTH_SERVICE_URL.replace(/\/+$/, '')}/api/v1/internal/shops/${encodeURIComponent(shopId)}`,
        headers: {
          Accept: 'application/json',
          'X-Internal-Service-Key': internalKey,
        },
      }] : []),
      ...(env.PRODUCT_SERVICE_URL ? [{
        url: `${env.PRODUCT_SERVICE_URL.replace(/\/+$/, '')}/shops/${encodeURIComponent(shopId)}`,
        headers: { Accept: 'application/json' },
      }] : []),
    ];

    for (const lookup of lookups) {
      try {
        const response = await fetch(lookup.url, {
          headers: lookup.headers,
          signal: AbortSignal.timeout(3000),
        });

        if (!response.ok) {
          continue;
        }

        const payload = (await response.json()) as {
          data?: { name?: unknown };
        };
        const name = payload.data?.name;
        if (typeof name === 'string' && name.trim()) {
          return name.trim();
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

export default new ShopLookupService();
import env from '@/config/env';

export interface InvoiceShopSnapshot {
  name: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
}

const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

class ShopLookupService {
  async getShopInvoiceSnapshot(shopId: string): Promise<InvoiceShopSnapshot | null> {
    try {
      const response = await fetch(
        `${env.PRODUCT_SERVICE_URL.replace(/\/+$/, '')}/shops/${encodeURIComponent(shopId)}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) },
      );
      if (!response.ok) return null;

      const payload = await response.json() as { data?: Record<string, unknown> };
      const shop = payload.data;
      if (!shop) return null;

      return {
        name: optionalText(shop.name),
        contactName: optionalText(shop.userName),
        contactEmail: optionalText(shop.sellerContactEmail),
        contactPhone: optionalText(shop.sellerContactPhone),
        address: optionalText(shop.originAddress),
      };
    } catch {
      return null;
    }
  }

  async getShopIdsForUser(userId: string, token: string): Promise<string[]> {
    const response = await fetch(
      `${env.PRODUCT_SERVICE_URL.replace(/\/+$/, '')}/shops/user/${encodeURIComponent(userId)}`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(3000),
      },
    );

    if (!response.ok) {
      throw new Error('Unable to verify owned shops');
    }

    const payload = await response.json() as { data?: unknown };
    if (!Array.isArray(payload.data)) {
      throw new Error('Owned shop response is invalid');
    }

    return [...new Set(payload.data.flatMap((shop: unknown) => {
      if (!shop || typeof shop !== 'object') return [];
      const id = (shop as { id?: unknown }).id;
      return typeof id === 'string' && id.trim() ? [id.trim()] : [];
    }))];
  }

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
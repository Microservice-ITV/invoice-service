import env from '@/config/env';
import type { OrderInvoiceSnapshotItem } from '@/services/order-snapshot.service';
import logger from '@/utils/logger';

type VariantAppearance = {
  color: string | null;
  size: string | null;
};

type VariantLineItem = {
  orderItemId?: string;
  sku?: string | null;
  color?: string | null;
  size?: string | null;
};

type ProductVariant = {
  sku?: unknown;
  color?: { name?: unknown; code?: unknown } | null;
  size?: { name?: unknown; code?: unknown } | null;
};

type ProductVariantResponse = {
  data?: {
    variants?: ProductVariant[];
  };
};

const PRODUCT_LOOKUP_CONCURRENCY = 8;
const PRODUCT_VARIANT_CACHE_LIMIT = 256;

const normalizeText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const SIZE_LABELS: Record<string, string> = {
  xs: 'XS',
  'x small': 'XS',
  'extra small': 'XS',
  s: 'S',
  sm: 'S',
  small: 'S',
  m: 'M',
  md: 'M',
  medium: 'M',
  l: 'L',
  lg: 'L',
  large: 'L',
  xl: 'XL',
  'x large': 'XL',
  'extra large': 'XL',
  '2xl': '2XL',
  xxl: '2XL',
  '3xl': '3XL',
  xxxl: '3XL',
  '4xl': '4XL',
  xxxxl: '4XL',
};

const sizeLabel = (name: unknown, code: unknown): string | null => {
  const rawName = normalizeText(name);
  const rawCode = normalizeText(code);
  const normalizeKey = (value: string) => value.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  const knownName = rawName ? SIZE_LABELS[normalizeKey(rawName)] : null;
  const knownCode = rawCode ? SIZE_LABELS[normalizeKey(rawCode)] : null;
  return knownName ?? knownCode ?? rawCode ?? rawName;
};

const variantAppearance = (variant: ProductVariant): VariantAppearance => ({
  color: normalizeText(variant.color?.name) ?? normalizeText(variant.color?.code),
  size: sizeLabel(variant.size?.name, variant.size?.code),
});

export class ProductVariantLookupService {
  private readonly cache = new Map<string, { expiresAt: number; variants: Map<string, VariantAppearance> | null }>();
  private readonly pending = new Map<string, Promise<Map<string, VariantAppearance> | null>>();

  constructor(private readonly request?: typeof fetch) {}

  async enrich<T extends VariantLineItem>(
    lineItems: T[],
    snapshotItems: OrderInvoiceSnapshotItem[],
  ): Promise<Array<T & VariantAppearance>> {
    const snapshotByOrderItemId = new Map(snapshotItems.map((item) => [item.orderItemId, item]));
    const snapshotBySku = new Map(
      snapshotItems.flatMap((item) => item.productSku ? [[item.productSku, item] as const] : []),
    );
    const matches = lineItems.map((item) => {
      const byId = item.orderItemId ? snapshotByOrderItemId.get(item.orderItemId) : undefined;
      return byId ?? (item.sku ? snapshotBySku.get(item.sku) : undefined);
    });

    const productIds = [...new Set(matches.flatMap((item, index) => {
      const sku = lineItems[index].sku ?? item?.productSku;
      const color = normalizeText(lineItems[index].color) ?? normalizeText(item?.color);
      const size = normalizeText(lineItems[index].size) ?? normalizeText(item?.size);
      return item && sku && (!color || !size) ? [item.productId] : [];
    }))];
    const variantsByProduct = new Map<string, Map<string, VariantAppearance>>();
    let nextProductIndex = 0;
    await Promise.all(Array.from({ length: Math.min(PRODUCT_LOOKUP_CONCURRENCY, productIds.length) }, async () => {
      while (nextProductIndex < productIds.length) {
        const productId = productIds[nextProductIndex];
        nextProductIndex += 1;
        const variants = await this.getProductVariants(productId);
        if (variants) variantsByProduct.set(productId, variants);
      }
    }));

    return lineItems.map((item, index) => {
      const snapshotItem = matches[index];
      const sku = item.sku ?? snapshotItem?.productSku;
      const appearance = snapshotItem && sku
        ? variantsByProduct.get(snapshotItem.productId)?.get(sku)
        : undefined;
      return {
        ...item,
        color: normalizeText(item.color) ?? normalizeText(snapshotItem?.color) ?? appearance?.color ?? null,
        size: normalizeText(item.size) ?? normalizeText(snapshotItem?.size) ?? appearance?.size ?? null,
      };
    });
  }

  private async getProductVariants(productId: string): Promise<Map<string, VariantAppearance> | null> {
    const cached = this.cache.get(productId);
    if (cached && cached.expiresAt > Date.now()) return cached.variants;

    const pending = this.pending.get(productId);
    if (pending) return pending;

    const request = this.fetchProductVariants(productId);
    this.pending.set(productId, request);
    try {
      const variants = await request;
      if (this.cache.size >= PRODUCT_VARIANT_CACHE_LIMIT) {
        const oldestProductId = this.cache.keys().next().value;
        if (oldestProductId) this.cache.delete(oldestProductId);
      }
      this.cache.set(productId, {
        expiresAt: Date.now() + (variants ? 60_000 : 10_000),
        variants,
      });
      return variants;
    } finally {
      this.pending.delete(productId);
    }
  }

  private async fetchProductVariants(productId: string): Promise<Map<string, VariantAppearance> | null> {
    const baseUrl = env.PRODUCT_SERVICE_URL.replace(/\/+$/, '');
    const url = `${baseUrl}/products/${encodeURIComponent(productId)}`;
    let response: Response;
    try {
      response = await (this.request ?? fetch)(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
    } catch (error) {
      logger.warn('Unable to retrieve product variant attributes for invoice items', {
        productId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (!response.ok) {
      logger.warn('Product service returned an error while retrieving invoice variant attributes', {
        productId,
        status: response.status,
      });
      return null;
    }

    let body: ProductVariantResponse;
    try {
      body = await response.json() as ProductVariantResponse;
    } catch (error) {
      logger.warn('Product service returned invalid variant data for invoice items', {
        productId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const variants = new Map<string, VariantAppearance>();
    for (const variant of body.data?.variants ?? []) {
      const sku = normalizeText(variant.sku);
      if (sku) variants.set(sku, variantAppearance(variant));
    }
    return variants;
  }
}

export default new ProductVariantLookupService();

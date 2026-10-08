import env from '@/config/env';

export interface OrderInvoiceSnapshotItem {
  orderItemId: string;
  productId: string;
  productName: string | null;
  productSku: string | null;
  imageUrl?: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string | null;
  shopId: string | null;
  shopName?: string | null;
}

export type InvoiceSnapshotAddress = Record<string, unknown>;

export interface OrderInvoiceSnapshot {
  orderId: string;
  checkoutId: string;
  customerId: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  billingAddress?: InvoiceSnapshotAddress | null;
  shippingAddress?: InvoiceSnapshotAddress | null;
  paymentStatus?: string | null;
  paymentMethod?: string | null;
  items: OrderInvoiceSnapshotItem[];
  currency: string | null;
  subtotal: string;
  deliveryFee: string;
  promotionDiscountTotal: string;
  grandTotal: string;
}

export interface OrderInvoiceCandidate {
  snapshot: OrderInvoiceSnapshot;
  createdAt: string;
  cursorAfter: string;
}

export interface OrderInvoiceCandidatePage {
  orders: OrderInvoiceCandidate[];
  nextCursor: string | null;
}

export class OrderSnapshotError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
    this.name = 'OrderSnapshotError';
  }
}

const getSafeResponseMessage = async (response: Response): Promise<string | null> => {
  if (response.status < 400 || response.status >= 500 || response.status === 401 || response.status === 403) {
    return null;
  }

  try {
    const body = await response.json() as { message?: unknown };
    if (
      typeof body.message !== 'string'
      || body.message.length > 160
      || !/^[A-Za-z0-9 .,:'()_-]+$/.test(body.message)
      || /(secret|password|token|authorization|credential|bearer|jwt|database|stack|trace)/i.test(body.message)
    ) {
      return null;
    }
    return body.message.trim() || null;
  } catch {
    return null;
  }
}

class OrderSnapshotService {
  private getRequestHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      'x-service-key': env.ORDER_SERVICE_API_KEY,
    };
  }

  async getInvoiceSnapshot(orderId: string): Promise<OrderInvoiceSnapshot> {
    const baseUrl = env.ORDER_SERVICE_URL.replace(/\/+$/, '');
    const url = `${baseUrl}/api/internal/orders/${encodeURIComponent(orderId)}/invoice-snapshot`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: this.getRequestHeaders(),
      });
    } catch {
      throw new OrderSnapshotError('Order Service invoice snapshot request could not be reached');
    }

    if (!response.ok) {
      const safeMessage = await getSafeResponseMessage(response);
      const detail = safeMessage ? `: ${safeMessage}` : '';
      throw new OrderSnapshotError(
        `Order Service invoice snapshot returned ${response.status}${detail}`,
        response.status,
      );
    }

    const snapshot = (await response.json()) as Partial<OrderInvoiceSnapshot>;
    if (
      snapshot.orderId !== orderId
      || typeof snapshot.checkoutId !== 'string'
      || typeof snapshot.customerId !== 'string' || !snapshot.customerId.trim()
      || !Array.isArray(snapshot.items)
      || typeof snapshot.subtotal !== 'string'
      || typeof snapshot.deliveryFee !== 'string'
      || typeof snapshot.promotionDiscountTotal !== 'string'
      || typeof snapshot.grandTotal !== 'string'
    ) {
      throw new OrderSnapshotError('Order snapshot response is invalid');
    }

    return snapshot as OrderInvoiceSnapshot;
  }

  async getInvoiceCandidates(limit = 50, cursor?: string | null): Promise<OrderInvoiceCandidatePage> {
    const baseUrl = env.ORDER_SERVICE_URL.replace(/\/+$/, '');
    const url = new URL(`${baseUrl}/api/internal/orders/invoice-candidates`);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);

    let response: Response;
    try {
      response = await fetch(url, { headers: this.getRequestHeaders() });
    } catch {
      throw new OrderSnapshotError('Order Service invoice candidate request could not be reached');
    }

    if (!response.ok) {
      const safeMessage = await getSafeResponseMessage(response);
      const detail = safeMessage ? `: ${safeMessage}` : '';
      throw new OrderSnapshotError(
        `Order Service invoice candidate request returned ${response.status}${detail}`,
        response.status,
      );
    }

    const page = await response.json() as Partial<OrderInvoiceCandidatePage>;
    if (
      !Array.isArray(page.orders)
      || (page.nextCursor !== null && typeof page.nextCursor !== 'string')
    ) {
      throw new OrderSnapshotError('Order Service invoice candidate response is invalid');
    }

    for (const candidate of page.orders) {
      if (
        !candidate
        || typeof candidate.createdAt !== 'string'
        || typeof candidate.cursorAfter !== 'string'
        || !this.isInvoiceSnapshot(candidate.snapshot)
      ) {
        throw new OrderSnapshotError('Order Service invoice candidate response is invalid');
      }
    }

    return page as OrderInvoiceCandidatePage;
  }

  private isInvoiceSnapshot(value: unknown): value is OrderInvoiceSnapshot {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value as Partial<OrderInvoiceSnapshot>;
    return (
      typeof snapshot.orderId === 'string'
      && typeof snapshot.checkoutId === 'string'
      && typeof snapshot.customerId === 'string'
      && snapshot.customerId.trim() !== ''
      && Array.isArray(snapshot.items)
      && typeof snapshot.subtotal === 'string'
      && typeof snapshot.deliveryFee === 'string'
      && typeof snapshot.promotionDiscountTotal === 'string'
      && typeof snapshot.grandTotal === 'string'
    );
  }
}

export default new OrderSnapshotService();
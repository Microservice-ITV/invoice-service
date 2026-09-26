import env from '@/config/env';

export interface OrderInvoiceSnapshotItem {
  orderItemId: string;
  productId: string;
  productName: string | null;
  productSku: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string | null;
  shopId: string | null;
  shopName?: string | null;
}

export interface OrderInvoiceSnapshot {
  orderId: string;
  checkoutId: string;
  customerId: string;
  customerName?: string | null;
  customerEmail?: string | null;
  items: OrderInvoiceSnapshotItem[];
  currency: string | null;
  subtotal: string;
  deliveryFee: string;
  promotionDiscountTotal: string;
  grandTotal: string;
}

export class OrderSnapshotError extends Error {
  readonly statusCode = 502;
}

class OrderSnapshotService {
  async getInvoiceSnapshot(orderId: string): Promise<OrderInvoiceSnapshot> {
    const baseUrl = env.ORDER_SERVICE_URL.replace(/\/+$/, '');
    const url = `${baseUrl}/api/internal/orders/${encodeURIComponent(orderId)}/invoice-snapshot`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'x-service-key': env.ORDER_SERVICE_API_KEY,
      },
    });

    if (!response.ok) {
      throw new OrderSnapshotError(`Order snapshot request failed with status ${response.status}`);
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
}

export default new OrderSnapshotService();
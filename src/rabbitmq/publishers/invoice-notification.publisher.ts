import { getRabbitChannel } from '@/rabbitmq/connection';
import { rabbitConfig } from '@/rabbitmq/config';
import logger from '@/utils/logger';

export type InvoiceNotificationType = 'invoice.generated' | 'invoice.paid';

type InvoiceNotificationRecord = {
  id: string;
  invoiceNumber: string;
  orderId: string;
  shopId: string;
  shopName: string | null;
  customerId: string;
  customerName: string | null;
  customerEmail: string | null;
  subtotal: { toString(): string };
  taxAmount: { toString(): string };
  deliveryFee: { toString(): string };
  discountAmount: { toString(): string };
  grandTotal: { toString(): string };
  currency: string;
  paymentMethod: string | null;
  status: string;
  createdAt: Date;
  lineItems: unknown;
  pdfUrl: string | null;
};

export const buildInvoiceNotificationEvent = (
  type: InvoiceNotificationType,
  invoice: InvoiceNotificationRecord,
) => ({
  event_id: `invoice:${invoice.id}:${type === 'invoice.generated' ? 'generated' : 'paid'}`,
  event: type,
  version: 'v1',
  timestamp: new Date().toISOString(),
  producer: 'invoice-service',
  data: {
    invoice_id: invoice.id,
    invoice_number: invoice.invoiceNumber,
    order_id: invoice.orderId,
    shop_id: invoice.shopId,
    shop_name: invoice.shopName,
    customer_id: invoice.customerId,
    customer_name: invoice.customerName,
    customer_email: invoice.customerEmail,
    invoice_date: invoice.createdAt.toISOString(),
    payment_method: invoice.paymentMethod,
    payment_status: invoice.status,
    currency: invoice.currency,
    items: invoice.lineItems,
    subtotal: invoice.subtotal.toString(),
    tax_amount: invoice.taxAmount.toString(),
    delivery_fee: invoice.deliveryFee.toString(),
    discount_amount: invoice.discountAmount.toString(),
    grand_total: invoice.grandTotal.toString(),
    pdf_url: invoice.pdfUrl,
  },
});

class InvoiceNotificationPublisher {
  async publish(type: InvoiceNotificationType, invoice: InvoiceNotificationRecord): Promise<void> {
    const event = buildInvoiceNotificationEvent(type, invoice);
    const channel = await getRabbitChannel();
    channel.publish(
      rabbitConfig.exchange,
      type,
      Buffer.from(JSON.stringify(event)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: event.event_id,
      },
    );
    logger.info('invoice_notification_published', {
      eventId: event.event_id,
      invoiceId: invoice.id,
      eventType: type,
    });
  }
}

export default new InvoiceNotificationPublisher();

import { ConsumeMessage } from 'amqplib';
import { getRabbitChannel } from '@/rabbitmq/connection';
import { rabbitConfig } from '@/rabbitmq/config';
import invoiceService from '@/services/invoice.service';
import logger from '@/utils/logger';
import { InvoiceLineItem } from '@/types/invoice';

export const startOrderPaidConsumer = async (): Promise<void> => {
  const channel = await getRabbitChannel();
  const queueName = 'invoice.order.paid';
  await channel.assertQueue(queueName, { durable: true });
  await channel.bindQueue(queueName, rabbitConfig.exchange, 'order.paid');

  await channel.consume(queueName, async (message: ConsumeMessage | null) => {
    if (!message) return;
    try {
      const envelope = JSON.parse(message.content.toString()) as { data?: Record<string, unknown> };
      const data: Record<string, unknown> = envelope.data ?? {};
      const orderId = typeof data.order_id === 'string' ? data.order_id : '';
      const rawItems = Array.isArray(data.line_items) ? data.line_items : [];
      const lineItems = rawItems.filter((item: unknown): item is InvoiceLineItem => {
        if (!item || typeof item !== 'object') return false;
        const candidate = item as Partial<InvoiceLineItem>;
        return typeof candidate.name === 'string'
          && typeof candidate.quantity === 'number'
          && typeof candidate.unitPrice === 'string'
          && typeof candidate.total === 'string';
      });

      if (orderId) {
        const address = data.deliveryAddress as Record<string, unknown> | undefined;
        const snapshot: {
          orderId: string;
          lineItems?: InvoiceLineItem[];
          customerName?: string;
          customerEmail?: string;
        } = {
          orderId,
        };
        if (lineItems.length > 0) snapshot.lineItems = lineItems;
        if (typeof address?.full_name === 'string' && address.full_name.trim()) {
          snapshot.customerName = address.full_name.trim();
        }
        if (typeof address?.email === 'string' && address.email.trim()) {
          snapshot.customerEmail = address.email.trim();
        }
        if (snapshot.lineItems || snapshot.customerName || snapshot.customerEmail) {
          await invoiceService.updateOrderSnapshot(snapshot);
        }
      }
      channel.ack(message);
    } catch (error) {
      logger.error('Failed to process order.paid for invoice snapshot', error as Error);
      channel.nack(message, false, false);
    }
  });
};

export default startOrderPaidConsumer;
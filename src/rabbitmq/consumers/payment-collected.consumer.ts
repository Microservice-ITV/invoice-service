import { ConsumeMessage } from 'amqplib';
import { getRabbitChannel } from '@/rabbitmq/connection';
import { rabbitConfig } from '@/rabbitmq/config';
import invoiceService from '@/services/invoice.service';
import { getFinalInvoicePaymentStatus } from '@/services/invoice-event-policy';
import logger from '@/utils/logger';

export const startPaymentCollectedConsumer = async (): Promise<void> => {
  const channel = await getRabbitChannel();
  const queueName = rabbitConfig.queues.paymentCollected;
  await channel.assertQueue(queueName, { durable: true });
  await channel.bindQueue(queueName, rabbitConfig.exchange, rabbitConfig.routingKeys.paymentCollected);

  await channel.consume(queueName, async (message: ConsumeMessage | null) => {
    if (!message) return;
    try {
      const envelope = JSON.parse(message.content.toString()) as {
        event?: string;
        version?: string;
        data?: Record<string, unknown>;
      };
      const data = envelope.data ?? {};
      const paymentStatus = getFinalInvoicePaymentStatus(envelope.event ?? '', data);
      const paymentId = typeof data.payment_id === 'string' ? data.payment_id.trim() : '';
      const orderId = typeof data.order_id === 'string' ? data.order_id.trim() : '';
      const amount = data.amount;
      const currency = typeof data.currency === 'string' ? data.currency.trim() : '';
      const paymentMethod = typeof data.payment_method === 'string'
        ? data.payment_method.trim().toLowerCase()
        : '';

      if (
        envelope.event !== 'payment.collected'
        || envelope.version !== 'v1'
        || paymentStatus !== 'COLLECTED'
        || !paymentId
        || !orderId
        || paymentMethod !== 'cod'
        || typeof amount !== 'number'
        || !Number.isFinite(amount)
        || !currency
      ) {
        throw new Error('Invalid payment.collected invoice eligibility payload');
      }

      await invoiceService.createInvoiceFromPayment({
        paymentId,
        orderId,
        transactionId: paymentId,
        amount,
        currency,
        paymentStatus: 'COLLECTED',
        paymentMethod: 'COD',
      });

      channel.ack(message);
    } catch (error) {
      logger.error('Failed to create Invoice from payment.collected', error as Error);
      channel.nack(message, false, false);
    }
  });
};

export default startPaymentCollectedConsumer;
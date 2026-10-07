import { ConsumeMessage } from 'amqplib';
import { getRabbitChannel } from '@/rabbitmq/connection';
import { rabbitConfig } from '@/rabbitmq/config';
import invoiceService from '@/services/invoice.service';
import logger from '@/utils/logger';
import { getFinalInvoicePaymentStatus } from '@/services/invoice-event-policy';

export const startOrderPaidConsumer = async (): Promise<void> => {
  const channel = await getRabbitChannel();
  const queueName = rabbitConfig.queues.orderPaid;
  await channel.assertQueue(queueName, { durable: true });
  await channel.bindQueue(queueName, rabbitConfig.exchange, rabbitConfig.routingKeys.orderPaid);

  await channel.consume(queueName, async (message: ConsumeMessage | null) => {
    if (!message) return;
    try {
      const envelope = JSON.parse(message.content.toString()) as { data?: Record<string, unknown> };
      const data: Record<string, unknown> = envelope.data ?? {};
      const orderId = typeof data.order_id === 'string' ? data.order_id : '';

      if (orderId) {
        const paymentId = typeof data.payment_id === 'string' ? data.payment_id.trim() : '';
        const transactionId = typeof data.transaction_id === 'string' ? data.transaction_id.trim() : '';
        const currency = typeof data.currency === 'string' ? data.currency.trim() : '';
        const paymentStatus = getFinalInvoicePaymentStatus('order.paid', data);
        const paymentMethod = typeof data.payment_method === 'string'
          ? data.payment_method
          : paymentStatus === 'UNPAID'
            ? 'COD'
            : null;
        if (
          (paymentStatus === 'PAID' || paymentStatus === 'UNPAID')
          && paymentId
          && transactionId
          && currency
          && typeof data.amount === 'number'
          && Number.isFinite(data.amount)
        ) {
          await invoiceService.createInvoiceFromPayment({
            paymentId,
            orderId,
            transactionId,
            amount: data.amount,
            currency,
            paymentStatus,
            paymentMethod,
          });
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
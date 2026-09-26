import { ConsumeMessage } from 'amqplib';
import { getRabbitChannel } from '@/rabbitmq/connection';
import { rabbitConfig } from '@/rabbitmq/config';
import invoiceService from '@/services/invoice.service';
import logger from '@/utils/logger';

import { PaymentCompletedEvent } from '@/types/invoice';

export const startPaymentCompletedConsumer = async (): Promise<void> => {
  const channel = await getRabbitChannel();

  const queueName = 'invoice.payment.completed';

  await channel.assertQueue(queueName, { durable: true });
  await channel.bindQueue(queueName, rabbitConfig.exchange, rabbitConfig.routingKeys.paymentCompleted);

  await channel.consume(queueName, async (message: ConsumeMessage | null) => {
    if (!message) {
      return;
    }

    try {
      const content = message.content.toString();
      const event = JSON.parse(content) as Partial<PaymentCompletedEvent>;
      const data = event.data;

      if (event.event !== 'payment.completed' || event.version !== 'v1' || !data
        || !data.payment_id?.trim() || !data.order_id?.trim() || !data.transaction_id?.trim()
        || !data.checkout_id?.trim() || typeof data.amount !== 'number' || !Number.isFinite(data.amount)
        || !data.currency?.trim()) {
        throw  new Error('Invalid payment.completed payload');
      }

      logger.info(
        `Processing payment.completed event=${event.event_id ?? 'unknown'} payment=${data.payment_id} order=${data.order_id} transaction=${data.transaction_id}`,
      );

      await invoiceService.createInvoiceFromPayment({
        paymentId: data.payment_id,
        orderId: data.order_id,
        transactionId: data.transaction_id,
        amount: data.amount,
        currency: data.currency,
        paymentMethod: data.payment_method ?? null,
        shopName: data.shop_name ?? null,
        customerName: data.customer_name ?? null,
        customerEmail: data.customer_email ?? null,
      });

      channel.ack(message);
    } catch (error) {
      logger.error('Failed to process payment.completed event', error as Error);
      channel.nack(message, false, false);
    }
  });
};

export default startPaymentCompletedConsumer;

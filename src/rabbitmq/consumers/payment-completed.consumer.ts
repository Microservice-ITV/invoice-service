import { ConsumeMessage } from 'amqplib';
import { getRabbitChannel } from '@/rabbitmq/connection';
import { rabbitConfig } from '@/rabbitmq/config';
import logger from '@/utils/logger';

import { PaymentCompletedEvent } from '@/types/invoice';

export const startPaymentCompletedConsumer = async (): Promise<void> => {
  const channel = await getRabbitChannel();

  const queueName = rabbitConfig.queues.paymentCompleted;

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
        || !data.payment_id?.trim() || !data.transaction_id?.trim()
        || !data.checkout_id?.trim() || typeof data.amount !== 'number' || !Number.isFinite(data.amount)
        || !data.currency?.trim()) {
        throw  new Error('Invalid payment.completed payload');
      }

      logger.info(`Acknowledging payment.completed; Invoice creation waits for final order or COD collection payment=${data.payment_id}`);
      channel.ack(message);
    } catch (error) {
      logger.error('Failed to process payment.completed event', error as Error);
      channel.nack(message, false, false);
    }
  });
};

export default startPaymentCompletedConsumer;

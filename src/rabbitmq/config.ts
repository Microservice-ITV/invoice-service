import env from '@/config/env';

export const rabbitConfig = {
  url: env.RABBITMQ_URL,
  exchange: env.RABBITMQ_EXCHANGE,
  exchangeType: 'topic' as const,
  routingKeys: {
    paymentCompleted: env.RABBITMQ_PAYMENT_COMPLETED_KEY,
    paymentCollected: env.RABBITMQ_PAYMENT_COLLECTED_KEY,
    orderPaid: env.RABBITMQ_ORDER_PAID_KEY,
  },
  queues: {
    paymentCompleted: env.RABBITMQ_PAYMENT_COMPLETED_QUEUE,
    paymentCollected: env.RABBITMQ_PAYMENT_COLLECTED_QUEUE,
    orderPaid: env.RABBITMQ_ORDER_PAID_QUEUE,
  },
};

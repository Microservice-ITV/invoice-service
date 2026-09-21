import env from '@/config/env';

export const rabbitConfig = {
  url: env.RABBITMQ_URL,
  exchange: env.RABBITMQ_EXCHANGE,
  exchangeType: 'topic' as const,
  routingKeys: {
    paymentCompleted: env.RABBITMQ_PAYMENT_COMPLETED_KEY,
  },
};

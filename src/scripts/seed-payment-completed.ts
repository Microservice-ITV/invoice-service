import { ConfirmChannel, connect } from 'amqplib';
import { rabbitConfig } from '@/rabbitmq/config';
import { closeRabbitConnection } from '@/rabbitmq/connection';

const defaultOrderId = '7f2f5f3d-0c75-4c47-8bb1-b3e7d3b9e101';

const seedEvent = {
  event_id: process.env.SEED_EVENT_ID ?? `seed-${Date.now()}`,
  event: 'payment.completed',
  version: 'v1',
  timestamp: new Date().toISOString(),
  producer: 'invoice-service-seed',
  correlation_id: process.env.SEED_CORRELATION_ID ?? `seed-correlation-${Date.now()}`,
  data: {
    payment_id: process.env.SEED_PAYMENT_ID ?? `seed-payment-${Date.now()}`,
    order_id: process.env.SEED_ORDER_ID ?? defaultOrderId,
    transaction_id: process.env.SEED_TRANSACTION_ID ?? `seed-transaction-${Date.now()}`,
    checkout_id: process.env.SEED_CHECKOUT_ID ?? `seed-checkout-${Date.now()}`,
    amount: Number(process.env.SEED_AMOUNT ?? '105000.00'),
    currency: process.env.SEED_CURRENCY ?? 'MMK',
    shop_name: process.env.SEED_SHOP_NAME ?? 'Main Store',
    customer_name: process.env.SEED_CUSTOMER_NAME ?? 'Seed Customer',
    customer_email: process.env.SEED_CUSTOMER_EMAIL ?? 'seed.customer@example.com',
    updatedAt: new Date().toISOString(),
  },
};

const publishSeedEvent = async (): Promise<void> => {
  const connection = await connect(rabbitConfig.url);
  const channel: ConfirmChannel = await connection.createConfirmChannel();

  try {
    await channel.assertExchange(rabbitConfig.exchange, rabbitConfig.exchangeType, {
      durable: true,
    });

    channel.publish(
      rabbitConfig.exchange,
      rabbitConfig.routingKeys.paymentCompleted,
      Buffer.from(JSON.stringify(seedEvent)),
      { contentType: 'application/json', persistent: true },
    );

    await channel.waitForConfirms();
    console.log('Published payment.completed seed event:');
    console.log(JSON.stringify(seedEvent, null, 2));
  } finally {
    await channel.close();
    await connection.close();
    await closeRabbitConnection();
  }
};

publishSeedEvent().catch((error: unknown) => {
  console.error('Failed to publish payment.completed seed event:', error);
  process.exitCode = 1;
});
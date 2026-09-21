import { ConfirmChannel, connect } from 'amqplib';
import { rabbitConfig } from '@/rabbitmq/config';
import { closeRabbitConnection } from '@/rabbitmq/connection';

const defaultShopId = '00468bc2-856e-4852-9e38-2609acb7e6cd';
const defaultCustomerId = 'd2f3c1c4-1234-4d64-8d2e-4e2d6f0b4567';
const defaultOrderId = '7f2f5f3d-0c75-4c47-8bb1-b3e7d3b9e101';

const seedEvent = {
  eventId: process.env.SEED_EVENT_ID ?? `seed-${Date.now()}`,
  orderId: process.env.SEED_ORDER_ID ?? defaultOrderId,
  shopId: process.env.SEED_SHOP_ID ?? defaultShopId,
  customerId: process.env.SEED_CUSTOMER_ID ?? defaultCustomerId,
  paymentMethod: process.env.SEED_PAYMENT_METHOD ?? 'CARD',
  paymentGatewayRef: process.env.SEED_PAYMENT_GATEWAY_REF ?? 'seed-payment-ref-001',
  paymentSlipUrl: null,
  currency: process.env.SEED_CURRENCY ?? 'MMK',
  subtotal: process.env.SEED_SUBTOTAL ?? '225000.00',
  taxAmount: process.env.SEED_TAX_AMOUNT ?? '5000.00',
  discountAmount: process.env.SEED_DISCOUNT_AMOUNT ?? '0.00',
  grandTotal: process.env.SEED_GRAND_TOTAL ?? '230000.00',
  lineItems: [
    {
      name: 'Everyday essentials bundle',
      quantity: 2,
      unitPrice: '75000.00',
      total: '150000.00',
    },
    {
      name: 'Household supplies pack',
      quantity: 3,
      unitPrice: '25000.00',
      total: '75000.00',
    },
  ],
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
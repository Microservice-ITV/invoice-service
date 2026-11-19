import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connect, ConfirmChannel, ConsumeMessage } from 'amqplib';

import {
  declareOrderPaidQueues,
  getOrderPaidQueueTopology,
  processOrderPaidMessage,
} from '@/rabbitmq/consumers/order-paid.consumer';
import { rabbitConfig } from '@/rabbitmq/config';
import {
  createIsolatedOrderPaidQueueNames,
  validateLocalOrderPaidTestBrokerUrl,
} from '@/rabbitmq/order-paid-integration-safety';

type IntegrationDlqMessage = {
  orderId?: unknown;
  attemptCount?: unknown;
  retryCount?: unknown;
  maxAttempts?: unknown;
  originalMessage?: { data?: { order_id?: unknown } };
  originalMessageBase64?: unknown;
  originalProperties?: { correlationId?: unknown };
  error?: { code?: unknown };
};

const makePayload = (orderId: string) => ({
  event: 'order.paid',
  version: 'v1',
  data: {
    order_id: orderId,
    payment_id: `payment-${orderId}`,
    transaction_id: `transaction-${orderId}`,
    amount: 125,
    currency: 'MMK',
    payment_status: 'PAID',
    payment_method: 'CARD',
  },
});

const publishConfirmed = (
  channel: ConfirmChannel,
  content: Buffer,
  topology: ReturnType<typeof getOrderPaidQueueTopology>,
  correlationId?: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    channel.publish(
      topology.exchange,
      rabbitConfig.routingKeys.orderPaid,
      content,
      {
        persistent: true,
        contentType: 'application/json',
        ...(correlationId ? { correlationId } : {}),
      },
      (error) => error ? reject(error) : resolve(),
    );
  });

const withTimeout = async <T>(
  promise: Promise<T>,
  description: string,
  milliseconds = 45_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const main = async (): Promise<void> => {
  const configuredUrl = process.env.RABBITMQ_URL;
  if (!configuredUrl) {
    throw new Error('RABBITMQ_URL is missing. Configure the isolated test vhost first.');
  }
  const url = validateLocalOrderPaidTestBrokerUrl(configuredUrl);

  const queueNames = createIsolatedOrderPaidQueueNames(
    rabbitConfig.queues.orderPaid,
    rabbitConfig.exchange,
    crypto.randomUUID(),
  );
  const topology = getOrderPaidQueueTopology(
    queueNames.source,
    queueNames.exchange,
    rabbitConfig.routingKeys.orderPaid,
  );

  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  let channel: ConfirmChannel | undefined;
  let sourceConsumerTag: string | undefined;
  let dlqConsumerTag: string | undefined;
  let testExchangeDeclared = false;

  const recoveryOrderId = `retry-recovery-${Date.now()}`;
  const exhaustedOrderId = `retry-exhausted-${Date.now()}`;
  const acknowledgmentProbeOrderId = `retry-ack-probe-${Date.now()}`;
  const exhaustedCorrelationId = `integration-${exhaustedOrderId}`;

  let recoveryAttempts = 0;
  let exhaustedAttempts = 0;

  let resolveRecovery!: (attempts: number) => void;
  let resolveAcknowledgmentProbe!: () => void;
  let resolveDlq!: (payload: IntegrationDlqMessage) => void;
  let rejectDlq!: (error: Error) => void;

  const recoveryResult = new Promise<number>((resolve) => {
    resolveRecovery = resolve;
  });

  const acknowledgmentProbeResult = new Promise<void>((resolve) => {
    resolveAcknowledgmentProbe = resolve;
  });

  const dlqResult = new Promise<IntegrationDlqMessage>((resolve, reject) => {
    resolveDlq = resolve;
    rejectDlq = reject;
  });

  try {
    connection = await connect(url);
    channel = await connection.createConfirmChannel();

    await channel.assertExchange(
      topology.exchange,
      rabbitConfig.exchangeType,
      { durable: true },
    );
    testExchangeDeclared = true;

    await declareOrderPaidQueues(channel, topology);
    await channel.prefetch(1);

    console.log('Declared isolated source, retry, and DLQ queues.');

    const dlqConsumer = await channel.consume(topology.sourceQueueName + '.dlq', (message) => {
      if (!message) return;

      try {
        const payload = JSON.parse(message.content.toString());
        channel!.ack(message);
        resolveDlq(payload);
      } catch (error) {
        channel!.nack(message, false, false);
        rejectDlq(error instanceof Error ? error : new Error(String(error)));
      }
    });

    dlqConsumerTag = dlqConsumer.consumerTag;

    const sourceConsumer = await channel.consume(
      topology.sourceQueueName,
      async (message: ConsumeMessage | null) => {
        if (!message) return;

        try {
          await processOrderPaidMessage(channel!, message, async (payload) => {
            if (payload.orderId === recoveryOrderId) {
              recoveryAttempts += 1;

              if (recoveryAttempts === 1) {
                throw Object.assign(
                  new Error('Integration test: simulated Prisma transaction timeout'),
                  { code: 'P2028' },
                );
              }

              resolveRecovery(recoveryAttempts);
              return;
            }

            if (payload.orderId === acknowledgmentProbeOrderId) {
              resolveAcknowledgmentProbe();
              return;
            }

            if (payload.orderId === exhaustedOrderId) {
              exhaustedAttempts += 1;

              throw Object.assign(
                new Error('Integration test: simulated persistent Prisma transaction timeout'),
                { code: 'P2028' },
              );
            }

            throw new Error(`Unexpected test order: ${payload.orderId}`);
          }, topology);
        } catch (error) {
          channel!.nack(message, false, true);
          console.error('Consumer handoff failed:', error);
        }
      },
    );

    sourceConsumerTag = sourceConsumer.consumerTag;

    console.log('\nTEST 1: Transient failure followed by successful retry');

    await publishConfirmed(
      channel,
      Buffer.from(JSON.stringify(makePayload(recoveryOrderId))),
      topology,
    );

    const recoveredAt = await withTimeout(
      recoveryResult,
      'successful retry',
    );

    assert.equal(recoveredAt, 2);
    console.log(`PASS: recovered successfully on attempt ${recoveredAt}.`);

    console.log('\nTEST 2: Five transient failures followed by DLQ transfer');

    await publishConfirmed(
      channel,
      Buffer.from(JSON.stringify(makePayload(exhaustedOrderId))),
      topology,
      exhaustedCorrelationId,
    );

    const deadLetter = await withTimeout(
      dlqResult,
      'dead-letter transfer',
      60_000,
    );

    assert.equal(exhaustedAttempts, 5);
    assert.equal(deadLetter.orderId, exhaustedOrderId);
    assert.equal(deadLetter.attemptCount, 5);
    assert.equal(deadLetter.retryCount, 4);
    assert.equal(deadLetter.maxAttempts, 5);
    assert.equal(deadLetter.originalProperties?.correlationId, exhaustedCorrelationId);
    assert.equal(
      deadLetter.originalMessage?.data?.order_id,
      exhaustedOrderId,
    );
    assert.ok(deadLetter.originalMessageBase64);
    assert.equal(deadLetter.error?.code, 'P2028');

    console.log('PASS: all five attempts failed and the message reached the DLQ.');
    console.log('PASS: original message, error code, and attempt metadata verified.');

    await publishConfirmed(
      channel,
      Buffer.from(JSON.stringify(makePayload(acknowledgmentProbeOrderId))),
      topology,
    );
    await withTimeout(
      acknowledgmentProbeResult,
      'source consumer progress after exhausted message ACK',
    );
    console.log('PASS: source consumer advanced after the exhausted delivery was acknowledged.');

    console.log('\nALL INTEGRATION TESTS PASSED.');
  } finally {
    if (channel && sourceConsumerTag) {
      await channel.cancel(sourceConsumerTag).catch(() => undefined);
    }

    if (channel && dlqConsumerTag) {
      await channel.cancel(dlqConsumerTag).catch(() => undefined);
    }

    if (channel) {
      for (const name of queueNames.cleanupQueues) {
        await channel.deleteQueue(name).catch((error) => {
          console.error(`Could not delete test queue ${name}:`, error);
        });
      }
      if (testExchangeDeclared) {
        await channel.deleteExchange(topology.exchange).catch((error) => {
          console.error(`Could not delete isolated test exchange ${topology.exchange}:`, error);
        });
      }

      await channel.close().catch(() => undefined);
    }

    if (connection) {
      await connection.close().catch(() => undefined);
    }

    console.log('\nIsolated test queues cleaned up.');
  }
};

main().catch((error) => {
  console.error('\nINTEGRATION TEST FAILED:', error);
  process.exitCode = 1;
});

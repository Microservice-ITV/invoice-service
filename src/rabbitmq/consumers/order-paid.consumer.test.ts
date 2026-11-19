import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ConsumeMessage, Message, Options } from 'amqplib';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mysql://invoice:invoice@localhost:3306/invoice_test';
process.env.LOG_LEVEL = 'error';
process.env.SERVICE_API_KEY = 'service-key-123456';
process.env.ORDER_SERVICE_URL = 'http://localhost:8000';
process.env.ORDER_SERVICE_API_KEY = 'order-key-123456';
process.env.MINIO_ENDPOINT = 'localhost';
process.env.MINIO_PORT = '9000';
process.env.MINIO_ACCESS_KEY = 'minioadmin';
process.env.MINIO_SECRET_KEY = 'minioadmin';
process.env.MINIO_BUCKET = 'invoices';
process.env.MINIO_USE_SSL = 'false';
process.env.PUBLIC_BASE_URL = 'http://localhost:9000';

import {
  declareOrderPaidQueues,
  isTransientOrderPaidFailure,
  processOrderPaidMessage,
} from '@/rabbitmq/consumers/order-paid.consumer';
import { rabbitConfig } from '@/rabbitmq/config';
import { OrderSnapshotError } from '@/services/order-snapshot.service';
import { ValidationError } from '@/services/invoice.service';

type TestChannel = Parameters<typeof processOrderPaidMessage>[0];

type PublishedMessage = {
  queueName: string;
  content: Buffer;
  options: Options.Publish | undefined;
};

const makePayload = (paymentStatus = 'PAID') => ({
  event: 'order.paid',
  version: 'v1',
  data: {
    order_id: 'order-123',
    payment_id: 'payment-456',
    transaction_id: 'transaction-789',
    amount: 125,
    currency: 'MMK',
    payment_status: paymentStatus,
    payment_method: paymentStatus === 'COD' ? 'COD' : 'CARD',
  },
});

const makeMessage = (
  payload: unknown = makePayload(),
  headers: Record<string, unknown> = {},
  correlationId?: string,
): ConsumeMessage => ({
  content: Buffer.from(JSON.stringify(payload)),
  fields: {
    consumerTag: 'invoice-order-paid',
    deliveryTag: 1,
    redelivered: false,
    exchange: rabbitConfig.exchange,
    routingKey: rabbitConfig.routingKeys.orderPaid,
  },
  properties: {
    contentType: 'application/json',
    headers,
    ...(correlationId ? { correlationId } : {}),
  },
} as ConsumeMessage);

const makeChannel = (configuration: {
  returnQueueName?: string;
  deferConfirm?: boolean;
} = {}) => {
  const acknowledged: number[] = [];
  const published: PublishedMessage[] = [];
  const queueDeclarations: Array<{ queueName: string; options: Options.AssertQueue | undefined }> = [];
  const returnEvents = new EventEmitter();
  const pendingConfirms: Array<(error: null) => void> = [];
  const channel: TestChannel = {
    ack: (message) => { acknowledged.push(message.fields.deliveryTag); },
    nack: () => undefined,
    sendToQueue: (queueName, content, options, callback) => {
      published.push({ queueName, content, options });
      if (queueName === configuration.returnQueueName && options?.mandatory) {
        returnEvents.emit('return', {
          content: Buffer.alloc(0),
          fields: {
            deliveryTag: 0,
            redelivered: false,
            exchange: '',
            routingKey: '',
            replyCode: 312,
            replyText: 'NO_ROUTE',
          },
          properties: {
            contentType: undefined,
            contentEncoding: undefined,
            headers: options.headers,
            deliveryMode: undefined,
            priority: undefined,
            correlationId: options.correlationId,
            replyTo: undefined,
            expiration: undefined,
            messageId: undefined,
            timestamp: undefined,
            type: undefined,
            userId: undefined,
            appId: undefined,
            clusterId: undefined,
          },
        } as Message);
      }
      if (configuration.deferConfirm && callback) {
        pendingConfirms.push((error) => callback(error, true));
      } else {
        callback?.(null, true);
      }
      return true;
    },
    assertQueue: async (queueName, options) => {
      queueDeclarations.push({ queueName, options });
      return { queue: queueName, messageCount: 0, consumerCount: 0 };
    },
    bindQueue: async () => ({}),
    on: returnEvents.on.bind(returnEvents) as TestChannel['on'],
    removeListener: returnEvents.removeListener.bind(returnEvents) as TestChannel['removeListener'],
  };
  return {
    channel,
    acknowledged,
    published,
    queueDeclarations,
    confirmNext: () => {
      const confirm = pendingConfirms.shift();
      assert.ok(confirm);
      confirm(null);
    },
    returnListenerCount: () => returnEvents.listenerCount('return'),
  };
};

test('transient transaction failures retry with exponential delay and a successful retry is acknowledged', async () => {
  const harness = makeChannel();
  const message = makeMessage(makePayload(), {}, 'source-correlation-id');
  const transactionError = Object.assign(new Error('Transaction timed out'), { code: 'P2028' });

  await processOrderPaidMessage(harness.channel, message, async () => {
    throw transactionError;
  });

  assert.equal(harness.published.length, 1);
  const retryPublication = harness.published[0];
  assert.ok(retryPublication);
  assert.equal(retryPublication.queueName, `${rabbitConfig.queues.orderPaid}.retry.1`);
  assert.equal(retryPublication.options?.headers?.['x-invoice-attempt'], 2);
  assert.equal(retryPublication.options?.correlationId, 'source-correlation-id');
  assert.equal(retryPublication.options?.headers?.['x-invoice-first-failed-at'] !== undefined, true);
  assert.equal(retryPublication.content.toString(), message.content.toString());
  assert.equal(harness.acknowledged.length, 1);

  const retryMessage = makeMessage(makePayload(), {
    ...retryPublication.options?.headers,
  });
  retryMessage.properties.headers = retryPublication.options?.headers;
  await processOrderPaidMessage(harness.channel, retryMessage, async () => undefined);

  assert.equal(harness.published.length, 1);
  assert.equal(harness.acknowledged.length, 2);
});

test('temporary snapshot API failures are classified and routed to retry', async () => {
  assert.equal(isTransientOrderPaidFailure(new OrderSnapshotError('temporarily unavailable', 503)), true);
  assert.equal(isTransientOrderPaidFailure(new OrderSnapshotError('not found', 404)), false);
  assert.equal(isTransientOrderPaidFailure(Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientOrderPaidFailure(Object.assign(new Error('Database pool timeout'), { code: 45028 })), true);

  const harness = makeChannel();
  await processOrderPaidMessage(harness.channel, makeMessage(), async () => {
    throw new OrderSnapshotError('temporarily unavailable', 503);
  });
  assert.equal(harness.published[0]?.queueName, `${rabbitConfig.queues.orderPaid}.retry.1`);
  assert.equal(harness.acknowledged.length, 1);
});

test('exhausted attempts transfer the original message and failure details to the DLQ', async () => {
  const harness = makeChannel();
  const message = makeMessage(makePayload(), {
    'x-invoice-attempt': 5,
    'x-invoice-first-failed-at': '2026-11-19T00:00:00.000Z',
  }, 'source-correlation-id');

  await processOrderPaidMessage(harness.channel, message, async () => {
    throw Object.assign(new Error('Database transaction failed'), { code: 'P2028' });
  });

  assert.equal(harness.published.length, 1);
  assert.equal(harness.published[0].queueName, `${rabbitConfig.queues.orderPaid}.dlq`);
  const deadLetter = JSON.parse(harness.published[0].content.toString()) as {
    originalMessage: unknown;
    originalMessageBase64: string;
    originalProperties: { correlationId?: string };
    orderId: string;
    error: { code?: string; message: string };
    failedAt: string;
    firstFailedAt: string;
    attemptCount: number;
    retryCount: number;
  };
  assert.deepEqual(deadLetter.originalMessage, makePayload());
  assert.equal(deadLetter.originalProperties.correlationId, 'source-correlation-id');
  assert.equal(harness.published[0].options?.correlationId, 'source-correlation-id');
  assert.equal(Buffer.from(deadLetter.originalMessageBase64, 'base64').toString(), message.content.toString());
  assert.equal(deadLetter.orderId, 'order-123');
  assert.equal(deadLetter.error.code, 'P2028');
  assert.equal(deadLetter.error.message, 'Database transaction failed');
  assert.equal(deadLetter.firstFailedAt, '2026-11-19T00:00:00.000Z');
  assert.ok(Number.isFinite(Date.parse(deadLetter.failedAt)));
  assert.equal(deadLetter.attemptCount, 5);
  assert.equal(deadLetter.retryCount, 4);
  assert.equal(harness.acknowledged.length, 1);
});

test('ineligible messages go directly to the DLQ without invoking invoice creation', async () => {
  const harness = makeChannel();
  const message = makeMessage(makePayload('CANCELLED'));
  let invoiceCreationCalls = 0;

  await processOrderPaidMessage(harness.channel, message, async () => {
    invoiceCreationCalls += 1;
    return undefined;
  });

  assert.equal(invoiceCreationCalls, 0);
  assert.equal(harness.published.length, 1);
  assert.equal(harness.published[0].queueName, `${rabbitConfig.queues.orderPaid}.dlq`);
  assert.equal(harness.acknowledged.length, 1);
});

test('permanent invoice validation failures do not consume retry attempts', async () => {
  const harness = makeChannel();

  await processOrderPaidMessage(harness.channel, makeMessage(), async () => {
    throw new ValidationError('Invalid invoice data');
  });

  assert.equal(harness.published.length, 1);
  assert.equal(harness.published[0]?.queueName, `${rabbitConfig.queues.orderPaid}.dlq`);
  assert.equal(harness.published[0]?.options?.headers?.['x-invoice-attempt'], 1);
});

test('retry handoff requires a mandatory route and its publisher confirmation before ack', async () => {
  const harness = makeChannel({ deferConfirm: true });
  const delivery = processOrderPaidMessage(harness.channel, makeMessage(), async () => {
    throw Object.assign(new Error('transaction timeout'), { code: 'P2028' });
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.acknowledged.length, 0);
  assert.equal(harness.published[0]?.options?.mandatory, true);
  assert.equal(
    harness.published[0]?.options?.headers?.['x-invoice-handoff-id'] !== undefined,
    true,
  );
  harness.confirmNext();
  await delivery;

  assert.equal(harness.acknowledged.length, 1);
  assert.equal(harness.returnListenerCount(), 0);
});

test('an unroutable retry handoff is not acknowledged', async () => {
  const retryQueue = `${rabbitConfig.queues.orderPaid}.retry.1`;
  const harness = makeChannel({ returnQueueName: retryQueue });

  await assert.rejects(
    processOrderPaidMessage(harness.channel, makeMessage(), async () => {
      throw Object.assign(new Error('transaction timeout'), { code: 'P2028' });
    }),
    /returned mandatory invoice handoff.*NO_ROUTE/,
  );

  assert.equal(harness.acknowledged.length, 0);
  assert.equal(harness.returnListenerCount(), 0);
});

test('an unroutable DLQ handoff is not acknowledged', async () => {
  const harness = makeChannel({
    returnQueueName: `${rabbitConfig.queues.orderPaid}.dlq`,
  });
  const message = makeMessage(makePayload(), { 'x-invoice-attempt': 5 });

  await assert.rejects(
    processOrderPaidMessage(harness.channel, message, async () => {
      throw Object.assign(new Error('transaction timeout'), { code: 'P2028' });
    }),
    /returned mandatory invoice handoff.*NO_ROUTE/,
  );

  assert.equal(harness.acknowledged.length, 0);
  assert.equal(harness.returnListenerCount(), 0);
});

test('duplicate successful deliveries are acknowledged and rely on invoice idempotency', async () => {
  const harness = makeChannel();
  const message = makeMessage();
  const storedInvoices = new Map<string, object>();
  let invoiceInsertCount = 0;
  const idempotentCreate = async (payload: { paymentId: string }) => {
    let invoice = storedInvoices.get(payload.paymentId);
    if (!invoice) {
      invoice = { id: 'invoice-1' };
      storedInvoices.set(payload.paymentId, invoice);
      invoiceInsertCount += 1;
    }
    return invoice;
  };

  await processOrderPaidMessage(harness.channel, message, idempotentCreate);
  await processOrderPaidMessage(harness.channel, message, idempotentCreate);

  assert.equal(invoiceInsertCount, 1);
  assert.equal(harness.acknowledged.length, 2);
});

test('queue setup leaves the production source queue arguments unchanged and durably declares retry and DLQ queues', async () => {
  const harness = makeChannel();
  await declareOrderPaidQueues(harness.channel);

  const sourceQueue = harness.queueDeclarations.find(
    (declaration) => declaration.queueName === rabbitConfig.queues.orderPaid,
  );
  const deadLetterQueue = harness.queueDeclarations.find(
    (declaration) => declaration.queueName === `${rabbitConfig.queues.orderPaid}.dlq`,
  );
  const firstRetryQueue = harness.queueDeclarations.find(
    (declaration) => declaration.queueName === `${rabbitConfig.queues.orderPaid}.retry.1`,
  );

  assert.deepEqual(sourceQueue?.options, { durable: true });
  assert.deepEqual(deadLetterQueue?.options, { durable: true });
  assert.ok(firstRetryQueue?.options);
  assert.equal(firstRetryQueue.options.durable, true);
  assert.equal(firstRetryQueue.options.arguments?.['x-message-ttl'], 1_000);
  assert.equal(
    firstRetryQueue.options.arguments?.['x-dead-letter-routing-key'],
    rabbitConfig.routingKeys.orderPaid,
  );
});

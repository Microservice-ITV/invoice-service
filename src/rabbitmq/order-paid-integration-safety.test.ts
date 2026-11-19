import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIsolatedOrderPaidQueueNames,
  validateLocalOrderPaidTestBrokerUrl,
} from '@/rabbitmq/order-paid-integration-safety';

test('RabbitMQ integration safety accepts only an exact local host and test vhost', () => {
  assert.equal(
    new URL(validateLocalOrderPaidTestBrokerUrl(
      'amqp://guest:guest@localhost:5672/invoice-retry-test',
    )).pathname,
    '/invoice-retry-test',
  );
  assert.equal(
    new URL(validateLocalOrderPaidTestBrokerUrl(
      'amqp://guest:guest@127.0.0.1:5672/invoice-retry-test',
    )).hostname,
    '127.0.0.1',
  );
  assert.throws(
    () => validateLocalOrderPaidTestBrokerUrl('amqp://guest:guest@localhost.evil:5672/invoice-retry-test'),
    /exact/,
  );
  assert.throws(
    () => validateLocalOrderPaidTestBrokerUrl('amqp://guest:guest@localhost:5672/invoice-retry-test-evil'),
    /exact/,
  );
  assert.throws(
    () => validateLocalOrderPaidTestBrokerUrl('amqp://guest:guest@rabbitmq:5672/invoice-retry-test'),
    /exact/,
  );
  assert.throws(
    () => validateLocalOrderPaidTestBrokerUrl('amqps://guest:guest@localhost:5671/invoice-retry-test'),
    /exact/,
  );
});

test('integration queue names are UUID-scoped and never equal application queues', () => {
  const first = createIsolatedOrderPaidQueueNames(
    'invoice.order.paid',
    'order_events',
    '11111111-1111-4111-8111-111111111111',
    123,
  );
  const second = createIsolatedOrderPaidQueueNames(
    'invoice.order.paid',
    'order_events',
    '22222222-2222-4222-8222-222222222222',
    123,
  );

  assert.notEqual(first.source, 'invoice.order.paid');
  assert.notEqual(first.deadLetter, 'invoice.order.paid.dlq');
  assert.notEqual(first.exchange, 'order_events');
  assert.notDeepEqual(first.cleanupQueues, second.cleanupQueues);
  assert.deepEqual(first.cleanupQueues, [
    first.source,
    first.deadLetter,
    ...first.retries,
  ]);
  assert.throws(
    () => createIsolatedOrderPaidQueueNames('invoice.order.paid', 'order_events', 'not-a-uuid', 123),
    /UUID/,
  );
});

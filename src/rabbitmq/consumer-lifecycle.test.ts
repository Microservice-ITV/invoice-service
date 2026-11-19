import assert from 'node:assert/strict';
import test from 'node:test';
import { RabbitConsumerLifecycle } from '@/rabbitmq/consumer-lifecycle';

test('consumer lifecycle initializes once when activated concurrently', async () => {
  let initializeCount = 0;
  const lifecycle = new RabbitConsumerLifecycle(async () => {
    initializeCount += 1;
    await Promise.resolve();
  });

  await Promise.all([lifecycle.start(), lifecycle.start(), lifecycle.start()]);
  await lifecycle.start();

  assert.equal(initializeCount, 1);
});

test('consumer lifecycle can retry initialization after a startup failure', async () => {
  let initializeCount = 0;
  const lifecycle = new RabbitConsumerLifecycle(async () => {
    initializeCount += 1;
    if (initializeCount === 1) throw new Error('RabbitMQ unavailable');
  });

  await assert.rejects(lifecycle.start(), /RabbitMQ unavailable/);
  await lifecycle.start();

  assert.equal(initializeCount, 2);
});

import crypto from 'node:crypto';

const LOCAL_RABBITMQ_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const ORDER_PAID_TEST_VHOST = 'invoice-retry-test';

export type IsolatedOrderPaidQueueNames = {
  source: string;
  deadLetter: string;
  retries: string[];
  exchange: string;
  cleanupQueues: string[];
};

export const validateLocalOrderPaidTestBrokerUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('RABBITMQ_URL must be a valid URL for the local invoice-retry-test broker.');
  }

  let virtualHost: string;
  try {
    virtualHost = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('RABBITMQ_URL contains an invalid virtual host path.');
  }

  if (
    url.protocol !== 'amqp:'
    || !LOCAL_RABBITMQ_HOSTS.has(url.hostname.toLowerCase())
    || virtualHost !== ORDER_PAID_TEST_VHOST
    || url.search
    || url.hash
  ) {
    throw new Error(
      `Safety check failed: integration tests require an amqp:// local broker using the exact /${ORDER_PAID_TEST_VHOST} vhost.`,
    );
  }

  return url.toString();
};

export const createIsolatedOrderPaidQueueNames = (
  applicationQueueName: string,
  applicationExchange: string,
  runId: string = crypto.randomUUID(),
  processId = process.pid,
): IsolatedOrderPaidQueueNames => {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) {
    throw new Error('Integration test run ID must be a UUID.');
  }
  if (!applicationQueueName.trim() || !applicationExchange.trim()) {
    throw new Error('Application queue and exchange names are required.');
  }

  const suffix = `it.${processId}.${runId}`;
  const source = `${applicationQueueName}.${suffix}`;
  const deadLetter = `${source}.dlq`;
  const retries = [1, 2, 3, 4].map((attempt) => `${source}.retry.${attempt}`);

  return {
    source,
    deadLetter,
    retries,
    exchange: `${applicationExchange}.${suffix}`,
    cleanupQueues: [source, deadLetter, ...retries],
  };
};

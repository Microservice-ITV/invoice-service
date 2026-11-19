import crypto from 'node:crypto';
import { ConfirmChannel, ConsumeMessage, Message, Options } from 'amqplib';
import { AppError } from '@/services/invoice.service';
import { OrderSnapshotError } from '@/services/order-snapshot.service';
import { getFinalInvoicePaymentStatus } from '@/services/invoice-event-policy';
import invoiceService from '@/services/invoice.service';
import { getRabbitChannel } from '@/rabbitmq/connection';
import { rabbitConfig } from '@/rabbitmq/config';
import logger from '@/utils/logger';

const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_ATTEMPT_HEADER = 'x-invoice-attempt';
const FIRST_FAILURE_HEADER = 'x-invoice-first-failed-at';
const LAST_ERROR_HEADER = 'x-invoice-last-error';

type OrderPaidChannel = Pick<
  ConfirmChannel,
  'ack' | 'nack' | 'sendToQueue' | 'assertQueue' | 'bindQueue' | 'on' | 'removeListener'
>;
export type OrderPaidQueueTopology = {
  sourceQueueName: string;
  exchange: string;
  routingKey: string;
};
type CreateInvoiceFromPayment = (
  payload: Parameters<typeof invoiceService.createInvoiceFromPayment>[0]
) => Promise<unknown>;
type ErrorDetails = {
  name: string;
  message: string;
  code?: string;
  statusCode?: number;
};

const TRANSIENT_ERROR_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2028',
  'P2034',
  '45028',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'ER_GET_CONNECTION',
  'ER_CON_COUNT_ERROR',
  'ER_SERVER_SHUTDOWN',
  'ER_SERVER_GONE_ERROR',
  'ER_SERVER_LOST',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
]);

const PERMANENT_ERROR_CODES = new Set([
  'P2000',
  'P2002',
  'P2003',
  'P2004',
  'P2005',
  'P2006',
  'P2007',
  'P2011',
  'P2012',
  'P2014',
  'P2015',
  'P2018',
  'P2020',
  'P2023',
  'P2025',
  'ER_DUP_ENTRY',
]);

class PermanentOrderPaidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentOrderPaidMessageError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getOrderIdForLogging = (content: Buffer): string | null => {
  try {
    const envelope: unknown = JSON.parse(content.toString());
    if (!isRecord(envelope) || !isRecord(envelope.data)) return null;
    const orderId = envelope.data.order_id;
    return typeof orderId === 'string' && orderId.trim() ? orderId.trim() : null;
  } catch {
    return null;
  }
};

const getAttempt = (message: ConsumeMessage): number => {
  const rawAttempt = message.properties.headers?.[RETRY_ATTEMPT_HEADER];
  const attempt = Number(rawAttempt);
  if (!Number.isInteger(attempt) || attempt < 1) return 1;
  return Math.min(attempt, MAX_DELIVERY_ATTEMPTS);
};

const getPreviousError = (message: ConsumeMessage): unknown => {
  const value = message.properties.headers?.[LAST_ERROR_HEADER];
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const errorDetails = (error: unknown): ErrorDetails => {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; statusCode?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof candidate.code === 'string' || typeof candidate.code === 'number'
        ? { code: String(candidate.code) }
        : {}),
      ...(typeof candidate.statusCode === 'number' ? { statusCode: candidate.statusCode } : {}),
    };
  }
  return { name: 'UnknownError', message: String(error) };
};

const isPermanentFailure = (error: unknown): boolean => {
  if (error instanceof PermanentOrderPaidMessageError) return true;

  if (error instanceof OrderSnapshotError || error instanceof AppError) {
    const statusCode = error.statusCode;
    return statusCode < 500 && statusCode !== 408 && statusCode !== 429;
  }

  return getErrorCodes(error).some((code) => PERMANENT_ERROR_CODES.has(code));
};

const getErrorCodes = (error: unknown): string[] => {
  const codes: string[] = [];
  const visited = new Set<object>();
  let current: unknown = error;

  while (isRecord(current) && !visited.has(current)) {
    visited.add(current);
    if (typeof current.code === 'string') codes.push(current.code);
    if (typeof current.code === 'number') codes.push(String(current.code));
    current = current.cause;
  }

  return codes;
};

export const isTransientOrderPaidFailure = (error: unknown): boolean => {
  if (error instanceof OrderSnapshotError) {
    return error.statusCode >= 500 || error.statusCode === 408 || error.statusCode === 429;
  }
  if (error instanceof AppError) {
    return error.statusCode >= 500 || error.statusCode === 408 || error.statusCode === 429;
  }

  if (getErrorCodes(error).some((code) => TRANSIENT_ERROR_CODES.has(code))) return true;

  let current = error;
  const visited = new Set<object>();
  while (isRecord(current) && !visited.has(current)) {
    visited.add(current);
    if (
      typeof current.message === 'string'
      && /(?:database )?connection (?:pool )?timeout|database pool timeout|could not connect|connection (?:refused|reset|closed)|server has gone away|lost connection to server|timed out retrieving a connection/i.test(current.message)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
};

export const getOrderPaidQueueTopology = (
  sourceQueueName = rabbitConfig.queues.orderPaid,
  exchange = rabbitConfig.exchange,
  routingKey = rabbitConfig.routingKeys.orderPaid,
): OrderPaidQueueTopology => ({ sourceQueueName, exchange, routingKey });

const retryQueueName = (
  index: number,
  sourceQueueName: string,
): string => `${sourceQueueName}.retry.${index + 1}`;

export const declareOrderPaidQueues = async (
  channel: OrderPaidChannel,
  topology = getOrderPaidQueueTopology(),
): Promise<void> => {
  const { sourceQueueName, exchange, routingKey } = topology;
  const queueName = sourceQueueName;
  await channel.assertQueue(queueName, { durable: true });
  await channel.assertQueue(`${queueName}.dlq`, { durable: true });

  for (const [index, delayMs] of rabbitConfig.orderPaidRetryDelaysMs.entries()) {
    await channel.assertQueue(retryQueueName(index, sourceQueueName), {
      durable: true,
      arguments: {
        'x-message-ttl': delayMs,
        'x-dead-letter-exchange': exchange,
        'x-dead-letter-routing-key': routingKey,
      },
    });
  }

  await channel.bindQueue(
    queueName,
    exchange,
    routingKey,
  );
};

const sendConfirmed = (
  channel: OrderPaidChannel,
  queueName: string,
  content: Buffer,
  options: Options.Publish,
): Promise<void> => new Promise((resolve, reject) => {
  const handoffId = crypto.randomUUID();
  let returnedMessage: Message | undefined;
  const onReturn = (message: Message): void => {
    if (message.properties.headers?.['x-invoice-handoff-id'] === handoffId) {
      returnedMessage = message;
    }
  };
  channel.on('return', onReturn);

  const cleanup = (): void => {
    channel.removeListener('return', onReturn);
  };
  const publishOptions: Options.Publish = {
    ...options,
    mandatory: true,
    headers: {
      ...(options.headers ?? {}),
      'x-invoice-handoff-id': handoffId,
    },
  };

  try {
    channel.sendToQueue(queueName, content, publishOptions, (error) => {
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      if (returnedMessage) {
        const returnedFields = returnedMessage.fields as Message['fields'] & {
          replyCode?: number;
          replyText?: string;
        };
        reject(new Error(
          `RabbitMQ returned mandatory invoice handoff for ${queueName} `
          + `(reply ${returnedFields.replyCode ?? 'unknown'}: ${returnedFields.replyText ?? 'unroutable'})`,
        ));
        return;
      }
      resolve();
    });
  } catch (error) {
    cleanup();
    reject(error);
  }
});

const forwardProperties = (
  message: ConsumeMessage,
  headers: Record<string, unknown>,
): Options.Publish => ({
  persistent: true,
  contentType: message.properties.contentType,
  contentEncoding: message.properties.contentEncoding,
  correlationId: message.properties.correlationId,
  replyTo: message.properties.replyTo,
  messageId: message.properties.messageId,
  timestamp: message.properties.timestamp,
  type: message.properties.type,
  appId: message.properties.appId,
  priority: message.properties.priority,
  headers,
});

const parseOriginalMessage = (content: Buffer): unknown => {
  const text = content.toString();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const transferToDlq = async (
  channel: OrderPaidChannel,
  message: ConsumeMessage,
  orderId: string | null,
  attempt: number,
  error: unknown,
  firstFailedAt: string,
  topology: OrderPaidQueueTopology,
): Promise<void> => {
  const failedAt = new Date().toISOString();
  const details = errorDetails(error);
  const headers = {
    ...(message.properties.headers ?? {}),
    [RETRY_ATTEMPT_HEADER]: attempt,
    [FIRST_FAILURE_HEADER]: firstFailedAt,
    'x-original-exchange': message.fields.exchange,
    'x-original-routing-key': message.fields.routingKey,
  };
  const deadLetter = {
    originalMessage: parseOriginalMessage(message.content),
    originalMessageBase64: message.content.toString('base64'),
    originalProperties: {
      contentType: message.properties.contentType,
      contentEncoding: message.properties.contentEncoding,
      correlationId: message.properties.correlationId,
      messageId: message.properties.messageId,
      headers: message.properties.headers ?? {},
    },
    orderId,
    error: details,
    firstFailedAt,
    failedAt,
    attemptCount: attempt,
    retryCount: Math.max(0, attempt - 1),
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
  };

  await sendConfirmed(
    channel,
    `${topology.sourceQueueName}.dlq`,
    Buffer.from(JSON.stringify(deadLetter)),
    {
      persistent: true,
      contentType: 'application/json',
      correlationId: message.properties.correlationId,
      messageId: message.properties.messageId,
      headers,
    },
  );
  logger.error('order_paid_invoice_dlq_transfer', {
    orderId,
    attempt,
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    error: details,
    failedAt,
    dlq: `${topology.sourceQueueName}.dlq`,
  });
};

const scheduleRetry = async (
  channel: OrderPaidChannel,
  message: ConsumeMessage,
  orderId: string | null,
  attempt: number,
  error: unknown,
  firstFailedAt: string,
  topology: OrderPaidQueueTopology,
): Promise<void> => {
  const details = errorDetails(error);
  const delayMs = rabbitConfig.orderPaidRetryDelaysMs[attempt - 1];
  const headers = {
    ...(message.properties.headers ?? {}),
    [RETRY_ATTEMPT_HEADER]: attempt + 1,
    [FIRST_FAILURE_HEADER]: firstFailedAt,
    [LAST_ERROR_HEADER]: JSON.stringify(details),
  };

  await sendConfirmed(
    channel,
    retryQueueName(attempt - 1, topology.sourceQueueName),
    message.content,
    forwardProperties(message, headers),
  );
  logger.warn('order_paid_invoice_retry_scheduled', {
    orderId,
    attempt,
    nextAttempt: attempt + 1,
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    retryDelayMs: delayMs,
    retryQueue: retryQueueName(attempt - 1, topology.sourceQueueName),
    error: details,
  });
};

const parseOrderPaidPayload = (
  content: Buffer,
): {
  orderId: string;
  payload: Parameters<CreateInvoiceFromPayment>[0];
} => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(content.toString());
  } catch {
    throw new PermanentOrderPaidMessageError('Message is not valid JSON');
  }
  if (!isRecord(envelope) || !isRecord(envelope.data)) {
    throw new PermanentOrderPaidMessageError('Message is missing its data object');
  }

  const data = envelope.data;
  const orderId = typeof data.order_id === 'string' ? data.order_id.trim() : '';
  const paymentId = typeof data.payment_id === 'string' ? data.payment_id.trim() : '';
  const transactionId = typeof data.transaction_id === 'string' ? data.transaction_id.trim() : '';
  const currency = typeof data.currency === 'string' ? data.currency.trim() : '';
  const paymentStatus = getFinalInvoicePaymentStatus('order.paid', data);

  if (!orderId || !paymentId || !transactionId || !currency) {
    throw new PermanentOrderPaidMessageError(
      'Message must include order_id, payment_id, transaction_id, and currency',
    );
  }
  if (paymentStatus !== 'PAID' && paymentStatus !== 'UNPAID') {
    throw new PermanentOrderPaidMessageError(
      `Order payment status is not eligible for invoice creation: ${String(data.payment_status ?? 'missing')}`,
    );
  }
  if (typeof data.amount !== 'number' || !Number.isFinite(data.amount)) {
    throw new PermanentOrderPaidMessageError('Message amount must be a finite number');
  }

  const paymentMethod = typeof data.payment_method === 'string'
    ? data.payment_method.trim()
    : paymentStatus === 'UNPAID'
      ? 'COD'
      : null;

  return {
    orderId,
    payload: {
      paymentId,
      orderId,
      transactionId,
      amount: data.amount,
      currency,
      paymentStatus,
      paymentMethod,
    },
  };
};

export const processOrderPaidMessage = async (
  channel: OrderPaidChannel,
  message: ConsumeMessage,
  createInvoice: CreateInvoiceFromPayment = (payload) => invoiceService.createInvoiceFromPayment(payload),
  topology = getOrderPaidQueueTopology(),
): Promise<void> => {
  const attempt = getAttempt(message);
  let orderId = getOrderIdForLogging(message.content);
  const previousError = getPreviousError(message);
  const startedAt = new Date().toISOString();
  logger.info('order_paid_invoice_attempt_started', {
    orderId,
    attempt,
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    errorDetails: previousError,
    startedAt,
  });

  let failure: unknown;
  let failed = false;
  try {
    const parsed = parseOrderPaidPayload(message.content);
    orderId = parsed.orderId;
    await createInvoice(parsed.payload);
  } catch (error) {
    failure = error;
    failed = true;
  }

  if (!failed) {
    channel.ack(message);
    logger.info(attempt > 1 ? 'order_paid_invoice_retry_recovered' : 'order_paid_invoice_processed', {
      orderId,
      attempt,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      errorDetails: previousError,
    });
    return;
  }

  const failureTimestamp = new Date().toISOString();
  const firstFailedAt = message.properties.headers?.[FIRST_FAILURE_HEADER];
  const firstFailureTimestamp = typeof firstFailedAt === 'string' ? firstFailedAt : failureTimestamp;
  const details = errorDetails(failure);
  if (isPermanentFailure(failure) || attempt >= MAX_DELIVERY_ATTEMPTS) {
    await transferToDlq(
      channel,
      message,
      orderId,
      attempt,
      failure,
      firstFailureTimestamp,
      topology,
    );
    channel.ack(message);
    return;
  }

  await scheduleRetry(
    channel,
    message,
    orderId,
    attempt,
    failure,
    firstFailureTimestamp,
    topology,
  );
  channel.ack(message);
  logger.info('order_paid_invoice_attempt_failed', {
    orderId,
    attempt,
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    failureType: isTransientOrderPaidFailure(failure) ? 'transient' : 'unexpected',
    error: details,
  });
};

export const startOrderPaidConsumer = async (): Promise<void> => {
  const channel = await getRabbitChannel();
  const topology = getOrderPaidQueueTopology();
  await declareOrderPaidQueues(channel, topology);

  await channel.consume(topology.sourceQueueName, async (message: ConsumeMessage | null) => {
    if (!message) return;

    try {
      await processOrderPaidMessage(channel, message, undefined, topology);
    } catch (error) {
      logger.error('order_paid_invoice_handoff_failed', {
        orderId: getOrderIdForLogging(message.content),
        attempt: getAttempt(message),
        error: errorDetails(error),
      });
      try {
        channel.nack(message, false, true);
      } catch (nackError) {
        logger.error('order_paid_invoice_message_requeue_failed', {
          orderId: getOrderIdForLogging(message.content),
          error: errorDetails(nackError),
        });
      }
    }
  });
};

export default startOrderPaidConsumer;

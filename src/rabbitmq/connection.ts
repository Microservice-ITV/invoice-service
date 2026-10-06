import { Channel, ChannelModel, connect } from 'amqplib';
import logger from '@/utils/logger';
import { rabbitConfig } from '@/rabbitmq/config';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let connecting: Promise<Channel> | null = null;
let reconnecting: Promise<void> | null = null;
let consumerInitializer: (() => Promise<void>) | null = null;
let shuttingDown = false;
const rabbitRetryCount = 15;
const rabbitRetryDelayMs = 2000;

const setupChannel = async (ch: Channel) => {
  await ch.assertExchange(rabbitConfig.exchange, rabbitConfig.exchangeType, {
    durable: true,
  });
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const closeCurrentConnection = async (): Promise<void> => {
  const currentChannel = channel;
  const currentConnection = connection;
  channel = null;
  connection = null;

  await Promise.allSettled([
    ...(currentChannel ? [currentChannel.close()] : []),
    ...(currentConnection ? [currentConnection.close()] : []),
  ]);
};

const scheduleReconnect = (): void => {
  if (shuttingDown || !consumerInitializer || reconnecting) {
    return;
  }

  reconnecting = (async () => {
    while (!shuttingDown) {
      await delay(rabbitRetryDelayMs);
      if (shuttingDown) return;

      try {
        await getRabbitChannel();
        await consumerInitializer?.();
        logger.info('RabbitMQ consumers reinitialized');
        return;
      } catch (error) {
        logger.error('RabbitMQ consumer recovery failed', error as Error);
        await closeCurrentConnection();
      }
    }
  })().finally(() => {
    reconnecting = null;
  });
};

const watchConnection = (conn: ChannelModel, ch: Channel): void => {
  let failureHandled = false;
  const handleFailure = (reason: Error | undefined, connectionClosed = false): void => {
    if (failureHandled || connection !== conn || channel !== ch) {
      return;
    }
    failureHandled = true;
    connection = null;
    channel = null;

    if (reason) {
      logger.error('RabbitMQ connection error', reason);
    } else {
      logger.warn('RabbitMQ connection closed');
    }

    if (!connectionClosed) {
      void Promise.allSettled([ch.close(), conn.close()]);
    }
    scheduleReconnect();
  };

  conn.on('error', (error) => handleFailure(error as Error));
  conn.on('close', () => handleFailure(undefined, true));
  ch.on('error', (error) => handleFailure(error as Error));
  ch.on('close', () => handleFailure(undefined));
};

const connectWithRetries = async (): Promise<Channel> => {
  for (let attempt = 1; attempt <= rabbitRetryCount; attempt += 1) {
    let conn: ChannelModel | null = null;
    let ch: Channel | null = null;
    try {
      conn = await connect(rabbitConfig.url);
      ch = await conn.createChannel();
      await setupChannel(ch);

      connection = conn;
      channel = ch;
      watchConnection(conn, ch);

      logger.info('RabbitMQ connected');
      return ch;
    } catch (error) {
      await Promise.allSettled([
        ...(ch ? [ch.close()] : []),
        ...(conn ? [conn.close()] : []),
      ]);
      if (attempt === rabbitRetryCount) {
        throw error;
      }

      logger.warn(
        `RabbitMQ unavailable, retrying (${attempt}/${rabbitRetryCount - 1})`,
      );
      await delay(rabbitRetryDelayMs);
    }
  }

  throw new Error('RabbitMQ connection attempts exhausted');
};

export const getRabbitChannel = async (): Promise<Channel> => {
  if (channel) return channel;
  if (connecting) return connecting;

  const pendingConnection = connectWithRetries();
  connecting = pendingConnection;
  try {
    return await pendingConnection;
  } finally {
    if (connecting === pendingConnection) {
      connecting = null;
    }
  }
};

export const setRabbitConsumerInitializer = (initializer: () => Promise<void>): void => {
  consumerInitializer = initializer;
};

export const closeRabbitConnection = async (): Promise<void> => {
  shuttingDown = true;
  await closeCurrentConnection();
};

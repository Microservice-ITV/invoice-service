import { Channel, ChannelModel, connect } from 'amqplib';
import logger from '@/utils/logger';
import { rabbitConfig } from '@/rabbitmq/config';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
const rabbitRetryCount = 15;
const rabbitRetryDelayMs = 2000;

const setupChannel = async (ch: Channel) => {
  await ch.assertExchange(rabbitConfig.exchange, rabbitConfig.exchangeType, {
    durable: true,
  });
};

export const getRabbitChannel = async (): Promise<Channel> => {
  if (channel) {
    return channel;
  }

  for (let attempt = 1; attempt <= rabbitRetryCount; attempt += 1) {
    try {
      const conn = await connect(rabbitConfig.url);
      const ch = await conn.createChannel();

      await setupChannel(ch);

      connection = conn;
      channel = ch;

      conn.on('error', (err) => {
        logger.error('RabbitMQ connection error', err as Error);
      });

      conn.on('close', () => {
        logger.warn('RabbitMQ connection closed');
        connection = null;
        channel = null;
      });

      logger.info('RabbitMQ connected');
      return ch;
    } catch (error) {
      if (attempt === rabbitRetryCount) {
        throw error;
      }

      logger.warn(
        `RabbitMQ unavailable, retrying (${attempt}/${rabbitRetryCount - 1})`,
      );
      await new Promise((resolve) => setTimeout(resolve, rabbitRetryDelayMs));
    }
  }

  throw new Error('RabbitMQ connection attempts exhausted');
};

export const closeRabbitConnection = async () => {
  try {
    if (channel) {
      await channel.close();
    }
    if (connection) {
      await connection.close();
    }
  } finally {
    channel = null;
    connection = null;
  }
};

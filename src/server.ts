import app from '@/app';
import env from '@/config/env';
import prisma from '@/config/database';
import {
  closeRabbitConnection,
  getRabbitChannel,
  setRabbitConsumerInitializer,
} from '@/rabbitmq/connection';
import { startPaymentCompletedConsumer } from '@/rabbitmq/consumers/payment-completed.consumer';
import { startPaymentCollectedConsumer } from '@/rabbitmq/consumers/payment-collected.consumer';
import { startOrderPaidConsumer } from '@/rabbitmq/consumers/order-paid.consumer';
import logger from '@/utils/logger';
import thermalPdfWorker from '@/services/thermal-pdf-worker.service';

const startServer = async (): Promise<void> => {
  try {
    await prisma.$connect();
    logger.info('Database connected');

    const initializeConsumers = async (): Promise<void> => {
      await startPaymentCompletedConsumer();
      await startOrderPaidConsumer();
      await startPaymentCollectedConsumer();
    };
    setRabbitConsumerInitializer(initializeConsumers);

    await getRabbitChannel();
    await initializeConsumers();
    thermalPdfWorker.start();
    logger.info('RabbitMQ consumer initialized');

    const server = app.listen(env.PORT, () => {
      logger.info(`Invoice service running on port ${env.PORT}`);
    });

    const shutdown = async (signal: string): Promise<void> => {
      logger.warn(`Received ${signal}, shutting down invoice service`);
      server.close(async () => {
        try {
          await thermalPdfWorker.stop();
          await prisma.$disconnect();
          await closeRabbitConnection();
          logger.info('Invoice service shut down gracefully');
          process.exit(0);
        } catch (error) {
          logger.error('Error during graceful shutdown', error as Error);
          process.exit(1);
        }
      });
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });

    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
  } catch (error) {
    logger.error('Failed to start Invoice Service', error as Error);
    process.exit(1);
  }
};

void startServer();

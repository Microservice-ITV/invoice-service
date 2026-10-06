import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import logger from '@/utils/logger';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const adapter = new PrismaMariaDb(databaseUrl);

const prisma = new PrismaClient({
  adapter,
  log: [
    { level: 'query', emit: 'event' },
    { level: 'error', emit: 'stdout' },
    { level: 'warn', emit: 'stdout' },
  ],
});

if (process.env.NODE_ENV === 'development') {
  prisma.$on('query', (event: { query: string; params: string; duration: number }) => {
    logger.debug('Query: ' + event.query);
    logger.debug('Params: ' + event.params);
    logger.debug('Duration: ' + event.duration + 'ms');
  });
}

process.once('beforeExit', async () => {
  await prisma.$disconnect();
  logger.info('Database connection closed');
});

export default prisma;

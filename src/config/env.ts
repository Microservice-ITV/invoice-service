import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).pipe(z.number().int().positive()).default('5005'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /**
   * Reachable frontend base URL used by Puppeteer to render the shared React
   * invoice print route. PDF generation fails explicitly when this is unset.
   */
  FRONTEND_BASE_URL: z.string().url('FRONTEND_BASE_URL must be a valid URL').optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  SERVICE_API_KEY: z.string().min(8, 'SERVICE_API_KEY is required'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').optional(),
    AUTH_SERVICE_URL: z.string().url('AUTH_SERVICE_URL must be a valid URL').default('http://authservice-nginx:80'),
  AUTH_SERVICE_INTERNAL_KEY: z.string().min(8).optional(),
  ORDER_SERVICE_URL: z.string().url('ORDER_SERVICE_URL must be a valid URL'),
  ORDER_SERVICE_API_KEY: z.string().min(8, 'ORDER_SERVICE_API_KEY is required'),
  PRODUCT_SERVICE_URL: z.string().url('PRODUCT_SERVICE_URL must be a valid URL')
    .default('http://host.docker.internal:5001/api/v1'),
  RABBITMQ_URL: z.string().default('amqp://localhost:5672'),
  RABBITMQ_EXCHANGE: z.string().default('order_events'),
  RABBITMQ_PAYMENT_COMPLETED_KEY: z.string().default('payment.completed'),
  RABBITMQ_PAYMENT_COLLECTED_KEY: z.string().default('payment.collected'),
  RABBITMQ_ORDER_PAID_KEY: z.string().default('order.paid'),
  RABBITMQ_PAYMENT_COMPLETED_QUEUE: z.string().default('invoice.payment.completed'),
  RABBITMQ_PAYMENT_COLLECTED_QUEUE: z.string().default('invoice.payment.collected'),
  RABBITMQ_ORDER_PAID_QUEUE: z.string().default('invoice.order.paid'),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.string().transform(Number).pipe(z.number().int().positive()).default('9000'),
  MINIO_ACCESS_KEY: z.string().min(1, 'MINIO_ACCESS_KEY is required'),
  MINIO_SECRET_KEY: z.string().min(1, 'MINIO_SECRET_KEY is required'),
  MINIO_BUCKET: z.string().default('invoices'),
  MINIO_PDF_BUCKET: z.string().default('invoice-documents'),
  MINIO_USE_SSL: z.string().transform((value) => value === 'true').default('false'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:9000'),
});

type Env = z.infer<typeof envSchema>;

let env: Env;

try {
  env = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('❌ Invalid environment variables:');
    error.errors.forEach((err) => {
      console.error(`  ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
  }

  throw error;
}

export default env as Env;

import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Client as MinioClient } from 'minio';
import env from '@/config/env';

const transportAgent = env.MINIO_USE_SSL
  ? new HttpsAgent({ keepAlive: true, timeout: env.PDF_RETENTION_DELETE_TIMEOUT_MS })
  : new HttpAgent({ keepAlive: true, timeout: env.PDF_RETENTION_DELETE_TIMEOUT_MS });

const clientOptions = {
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
};

export const s3Client = new MinioClient({
  ...clientOptions,
  transportAgent,
  retryOptions: { maximumRetryCount: 1 },
});

export const createPdfOperationClient = (overrides: { endPoint?: string; port?: number } = {}) => {
  const operationAgent = env.MINIO_USE_SSL
    ? new HttpsAgent({ keepAlive: false })
    : new HttpAgent({ keepAlive: false });

  let closed = false;
  return {
    client: new MinioClient({
      ...clientOptions,
      endPoint: overrides.endPoint ?? clientOptions.endPoint,
      port: overrides.port ?? clientOptions.port,
      transportAgent: operationAgent,
      retryOptions: { maximumRetryCount: 0, disableRetry: true },
    }),
    close: () => {
      if (closed) return;
      closed = true;
      operationAgent.destroy();
    },
  };
};

export const createPdfUploadClient = createPdfOperationClient;

export const s3Config = {
  bucket: env.MINIO_BUCKET,
  pdfBucket: env.MINIO_PDF_BUCKET,
  publicBaseUrl: env.PUBLIC_BASE_URL,
};

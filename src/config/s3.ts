import { Client as MinioClient } from 'minio';
import env from '@/config/env';

export const s3Client = new MinioClient({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
});

export const s3Config = {
  bucket: env.MINIO_BUCKET,
  publicBaseUrl: env.PUBLIC_BASE_URL,
};

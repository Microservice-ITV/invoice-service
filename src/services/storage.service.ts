import { s3Client, s3Config } from '@/config/s3';
import logger from '@/utils/logger';

const publicReadPolicy = (bucket: string): string => JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${bucket}/*`],
    },
  ],
});

export class StorageService {
  async uploadImageDataUrl(fileName: string, dataUrl: string): Promise<string> {
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid image data');

    const contentType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.byteLength > 5 * 1024 * 1024) throw new Error('Image must be 5MB or smaller');

    const extension = contentType.split('/')[1].replace('jpeg', 'jpg');
    const objectKey = `payment-slips/${fileName}.${extension}`;
    const exists = await s3Client.bucketExists(s3Config.bucket).catch(() => false);
    if (!exists) await s3Client.makeBucket(s3Config.bucket, 'us-east-1');
    await s3Client.setBucketPolicy(s3Config.bucket, publicReadPolicy(s3Config.bucket));
    await s3Client.putObject(s3Config.bucket, objectKey, buffer, buffer.byteLength, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000',
    });

    return `${s3Config.publicBaseUrl.replace(/\/+$/, '')}/${s3Config.bucket}/${objectKey}`;
  }

  async uploadPdf(fileName: string, buffer: Buffer): Promise<string> {
    const safeFileName = fileName.replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '');
    const objectKey = safeFileName.startsWith('invoices/') ? safeFileName : `invoices/${safeFileName}`;

    try {
      const exists = await s3Client.bucketExists(s3Config.bucket).catch(() => false);

      if (!exists) {
        await s3Client.makeBucket(s3Config.bucket, 'us-east-1');
      }

      await s3Client.setBucketPolicy(
        s3Config.bucket,
        publicReadPolicy(s3Config.bucket),
      );

      await s3Client.putObject(s3Config.bucket, objectKey, buffer, buffer.byteLength, {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'public, max-age=31536000',
      });

      const baseUrl = s3Config.publicBaseUrl.replace(/\/+$/, '');
      return `${baseUrl}/${s3Config.bucket}/${objectKey}`;
    } catch (error) {
      logger.error('Failed to upload PDF to object storage', error as Error);
      throw error;
    }
  }

  async downloadPdf(pdfUrl: string): Promise<Buffer> {
    const parsedUrl = new URL(pdfUrl);
    const bucketPrefix = `/${s3Config.bucket}/`;
    const bucketIndex = parsedUrl.pathname.indexOf(bucketPrefix);

    if (bucketIndex < 0) {
      throw new Error(`Invalid invoice PDF URL: ${pdfUrl}`);
    }

    const objectKey = decodeURIComponent(parsedUrl.pathname.slice(bucketIndex + bucketPrefix.length));
    const stream = await s3Client.getObject(s3Config.bucket, objectKey);
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }
}

export default new StorageService();

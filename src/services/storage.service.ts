import { createPdfOperationClient, createPdfUploadClient, s3Client, s3Config } from '@/config/s3';
import logger from '@/utils/logger';
import env from '@/config/env';

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

const getSafeErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') {
    return undefined;
  }
  return /^[A-Za-z0-9_-]{1,64}$/.test(error.code) ? error.code : undefined;
};

const withRequestDeadline = async <T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  timeoutCode: string,
  close: () => void,
): Promise<T> => {
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    close();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const request = operation();
    const timeout = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('PDF storage request timed out'), { code: timeoutCode }));
        closeOnce();
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    closeOnce();
  }
};

export class StorageService {
  constructor(
    private readonly createUploadClient = createPdfUploadClient,
    private readonly createOperationClient = createPdfOperationClient,
  ) {}

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
    const artifactRef = this.getPdfReference(fileName);
    const objectKey = artifactRef.slice('invoice-pdfs/'.length);
    const upload = this.createUploadClient();

    try {
      return await withRequestDeadline(async () => {
        const exists = await upload.client.bucketExists(s3Config.pdfBucket);
        if (!exists) await upload.client.makeBucket(s3Config.pdfBucket, 'us-east-1');
        await upload.client.putObject(s3Config.pdfBucket, objectKey, buffer, buffer.byteLength, {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'private, no-store',
        });
        return artifactRef;
      }, env.PDF_UPLOAD_TIMEOUT_MS, 'PDF_UPLOAD_TIMEOUT', upload.close);
    } catch (error) {
      const code = getSafeErrorCode(error);
      logger.error('Failed to upload PDF to object storage', { errorCode: code });
      throw Object.assign(new Error('PDF storage upload failed'), { code });
    }
  }

  async pdfExists(pdfUrl: string): Promise<boolean> {
    const objectKey = this.getManagedPdfObjectKey(pdfUrl);
    const operation = this.createOperationClient();
    try {
      await withRequestDeadline(
        () => operation.client.statObject(s3Config.pdfBucket, objectKey),
        env.PDF_RETENTION_HEAD_TIMEOUT_MS,
        'PDF_HEAD_TIMEOUT',
        operation.close,
      );
      return true;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : undefined;
      if (statusCode === 404 || code === 'NotFound' || code === 'NoSuchKey' || code === 'NoSuchObject') return false;
      throw error;
    }
  }

  getPdfReference(fileName: string): string {
    const safeFileName = fileName.replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '');
    const objectKey = safeFileName.replace(/^invoice-pdfs\//, '');
    return `invoice-pdfs/${objectKey}`;
  }

  async downloadPdf(pdfUrl: string): Promise<Buffer> {
    let bucket = s3Config.pdfBucket;
    let objectKey = pdfUrl;
    if (/^https?:\/\//i.test(pdfUrl)) {
      const parsedUrl = new URL(pdfUrl);
      const bucketPrefix = `/${s3Config.bucket}/`;
      const bucketIndex = parsedUrl.pathname.indexOf(bucketPrefix);
      if (bucketIndex < 0) throw new Error('Invalid invoice PDF reference');
      bucket = s3Config.bucket;
      objectKey = decodeURIComponent(parsedUrl.pathname.slice(bucketIndex + bucketPrefix.length));
    } else if (objectKey.startsWith('invoice-pdfs/')) {
      objectKey = objectKey.slice('invoice-pdfs/'.length);
    }

    const stream = await s3Client.getObject(bucket, objectKey);
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  async deletePdf(pdfUrl: string): Promise<void> {
    const objectKey = this.getManagedPdfObjectKey(pdfUrl);
    const operation = this.createOperationClient();
    await withRequestDeadline(
      () => operation.client.removeObject(s3Config.pdfBucket, objectKey),
      env.PDF_RETENTION_DELETE_TIMEOUT_MS,
      'PDF_DELETE_TIMEOUT',
      operation.close,
    );
  }

  private getManagedPdfObjectKey(pdfUrl: string): string {
    if (!pdfUrl.startsWith('invoice-pdfs/')) {
      throw new Error('Refusing to delete a PDF outside the managed PDF namespace');
    }

    const objectKey = pdfUrl.slice('invoice-pdfs/'.length);
    const segment = '[A-Za-z0-9][A-Za-z0-9._-]*';
    const patterns = [
      new RegExp(`^${segment}/react-print-v[0-9]+/${segment}-[0-9]+-[a-z0-9]+\\.pdf$`, 'i'),
      new RegExp(`^thermal/${segment}/${segment}/(?:58mm|80mm)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`, 'i'),
      new RegExp(`^thermal/receipts/${segment}/${segment}/(?:58mm|80mm)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`, 'i'),
      new RegExp(`^receipts/${segment}/receipt-v1/${segment}-[0-9]+-[a-z0-9]+\\.pdf$`, 'i'),
    ];

    if (!patterns.some((pattern) => pattern.test(objectKey))) {
      throw new Error('Refusing to delete an unrecognized generated PDF reference');
    }
    return objectKey;
  }
}

export default new StorageService();

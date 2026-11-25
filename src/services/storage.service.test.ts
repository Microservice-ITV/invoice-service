import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mysql://invoice:invoice@localhost:3306/invoice_test';
process.env.SERVICE_API_KEY = 'service-key-123456';
process.env.ORDER_SERVICE_URL = 'http://localhost:8000';
process.env.ORDER_SERVICE_API_KEY = 'order-key-123456';
process.env.MINIO_ENDPOINT = 'localhost';
process.env.MINIO_PORT = '9000';
process.env.MINIO_ACCESS_KEY = 'minioadmin';
process.env.MINIO_SECRET_KEY = 'minioadmin';
process.env.MINIO_BUCKET = 'invoices';
process.env.MINIO_PDF_BUCKET = 'invoice-documents';
process.env.MINIO_USE_SSL = 'false';
process.env.PUBLIC_BASE_URL = 'http://localhost:9000';

import env from '@/config/env';
import { createPdfOperationClient, createPdfUploadClient, s3Config } from '@/config/s3';
import { StorageService } from '@/services/storage.service';

type PdfClient = ReturnType<typeof createPdfOperationClient>['client'];

const createStorageWithOperationClient = (client: PdfClient, close = () => undefined): StorageService =>
  new StorageService(undefined, () => ({ client, close }));

test('deletePdf deletes only a recognized generated PDF object reference', async () => {
  const removed: Array<{ bucket: string; key: string }> = [];
  const client = {
    removeObject: async (bucket: string, key: string) => { removed.push({ bucket, key }); },
  } as unknown as PdfClient;

  await createStorageWithOperationClient(client).deletePdf(
    'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
  );
  assert.deepEqual(removed, [{
    bucket: s3Config.pdfBucket,
    key: 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
  }]);
});

test('deletePdf accepts generated thermal PDF references with UUID filenames', async () => {
  const removed: Array<{ bucket: string; key: string }> = [];
  const client = {
    removeObject: async (bucket: string, key: string) => { removed.push({ bucket, key }); },
  } as unknown as PdfClient;

  await createStorageWithOperationClient(client).deletePdf(
    'invoice-pdfs/thermal/shop-1/INV-1/58mm/123e4567-e89b-12d3-a456-426614174000.pdf',
  );
  assert.deepEqual(removed, [{
    bucket: s3Config.pdfBucket,
    key: 'thermal/shop-1/INV-1/58mm/123e4567-e89b-12d3-a456-426614174000.pdf',
  }]);
});

test('deletePdf rejects references outside the generated PDF key shapes', async () => {
  let removeCalls = 0;
  const client = {
    removeObject: async () => { removeCalls += 1; },
  } as unknown as PdfClient;
  const storage = createStorageWithOperationClient(client);
  await assert.rejects(storage.deletePdf('invoice-pdfs/payment-slips/invoice.pdf'));
  await assert.rejects(storage.deletePdf('invoice-pdfs/../payment-slip.pdf'));
  await assert.rejects(storage.deletePdf('https://storage.example/invoice.pdf'));
  await assert.rejects(storage.deletePdf('invoice-pdfs/thermal/shop-1/INV-1/58mm/deadbeef.pdf'));
  assert.equal(removeCalls, 0);
});

test('uploadPdf uses an isolated client and closes it after upload', async () => {
  const operations: string[] = [];
  let closeCalls = 0;
  const fakeClient = {
    bucketExists: async (bucket: string) => {
      operations.push(`bucketExists:${bucket}`);
      return true;
    },
    makeBucket: async () => {
      operations.push('makeBucket');
    },
    putObject: async (bucket: string, key: string, buffer: Buffer) => {
      operations.push(`putObject:${bucket}:${key}:${buffer.length}`);
      return { etag: 'etag' };
    },
  } as unknown as ReturnType<typeof createPdfUploadClient>['client'];
  const isolatedStorage = new StorageService(() => ({
    client: fakeClient,
    close: () => { closeCalls += 1; },
  }));

  const ref = await isolatedStorage.uploadPdf(
    'shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
    Buffer.from('%PDF'),
  );
  assert.equal(ref, 'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf');
  assert.deepEqual(operations, [
    `bucketExists:${s3Config.pdfBucket}`,
    `putObject:${s3Config.pdfBucket}:shop-1/react-print-v21/INV-1-123456789-123abc.pdf:4`,
  ]);
  assert.equal(closeCalls, 1);
});

test('uploadPdf does not expose raw storage errors to callers', async () => {
  let closeCalls = 0;
  const fakeClient = {
    bucketExists: async () => true,
    putObject: async () => {
      throw Object.assign(new Error('https://private-storage.example/key?signature=secret'), {
        code: 'AccessDenied',
      });
    },
  } as unknown as ReturnType<typeof createPdfUploadClient>['client'];
  const isolatedStorage = new StorageService(() => ({
    client: fakeClient,
    close: () => { closeCalls += 1; },
  }));

  await assert.rejects(
    isolatedStorage.uploadPdf('shop-1/react-print-v21/invoice-1-123456789-123abc.pdf', Buffer.from('%PDF')),
    (error: Error & { code?: string }) => {
      assert.equal(error.message, 'PDF storage upload failed');
      assert.equal(error.code, 'AccessDenied');
      assert.doesNotMatch(error.stack ?? '', /private-storage|signature=secret/);
      return true;
    },
  );
  assert.equal(closeCalls, 1);
});

test('uploadPdf does not treat bucket lookup failures as a missing bucket', async () => {
  const operations: string[] = [];
  let closeCalls = 0;
  const fakeClient = {
    bucketExists: async () => {
      operations.push('bucketExists');
      throw new Error('bucket lookup failed');
    },
    makeBucket: async () => {
      operations.push('makeBucket');
    },
    putObject: async () => {
      operations.push('putObject');
    },
  } as unknown as ReturnType<typeof createPdfUploadClient>['client'];
  const isolatedStorage = new StorageService(() => ({
    client: fakeClient,
    close: () => { closeCalls += 1; },
  }));

  await assert.rejects(
    isolatedStorage.uploadPdf('shop-1/react-print-v21/invoice-1-123456789-123abc.pdf', Buffer.from('%PDF')),
    /PDF storage upload failed/,
  );
  assert.deepEqual(operations, ['bucketExists']);
  assert.equal(closeCalls, 1);
});

test('stalled PDF PUT is cancelled at its absolute deadline and reports an ambiguous timeout', async () => {
  const originalTimeout = env.PDF_UPLOAD_TIMEOUT_MS;
  let closeCalls = 0;
  let cancelPut: (() => void) | undefined;
  const fakeClient = {
    bucketExists: async () => true,
    putObject: async () => new Promise<never>((_resolve, reject) => {
      cancelPut = () => reject(new Error('client socket closed'));
    }),
  } as unknown as ReturnType<typeof createPdfUploadClient>['client'];
  const storage = new StorageService(() => ({
    client: fakeClient,
    close: () => { closeCalls += 1; cancelPut?.(); },
  }));
  env.PDF_UPLOAD_TIMEOUT_MS = 15;

  try {
    await assert.rejects(
      storage.uploadPdf('shop-1/react-print-v21/invoice-1-123456789-123abc.pdf', Buffer.from('%PDF')),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'PDF_UPLOAD_TIMEOUT');
        assert.doesNotMatch(error.message, /socket closed/);
        return true;
      },
    );
    assert.equal(closeCalls, 1);
  } finally {
    env.PDF_UPLOAD_TIMEOUT_MS = originalTimeout;
  }
});

test('stalled HEAD and DELETE requests are cancelled and never treated as success', async () => {
  const originalHeadTimeout = env.PDF_RETENTION_HEAD_TIMEOUT_MS;
  const originalDeleteTimeout = env.PDF_RETENTION_DELETE_TIMEOUT_MS;
  const cancellations: Array<() => void> = [];
  let closeCalls = 0;
  const client = {
    statObject: async () => new Promise<never>((_resolve, reject) => {
      cancellations.push(() => reject(new Error('HEAD socket closed')));
    }),
    removeObject: async () => new Promise<never>((_resolve, reject) => {
      cancellations.push(() => reject(new Error('DELETE socket closed')));
    }),
  } as unknown as PdfClient;
  const storage = createStorageWithOperationClient(client, () => {
    closeCalls += 1;
    cancellations[cancellations.length - 1]?.();
  });
  env.PDF_RETENTION_HEAD_TIMEOUT_MS = 15;
  env.PDF_RETENTION_DELETE_TIMEOUT_MS = 15;
  const ref = 'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf';

  try {
    await assert.rejects(storage.pdfExists(ref), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'PDF_HEAD_TIMEOUT');
      return true;
    });
    await assert.rejects(storage.deletePdf(ref), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'PDF_DELETE_TIMEOUT');
      return true;
    });
    assert.equal(closeCalls, 2);
  } finally {
    env.PDF_RETENTION_HEAD_TIMEOUT_MS = originalHeadTimeout;
    env.PDF_RETENTION_DELETE_TIMEOUT_MS = originalDeleteTimeout;
  }
});

test('a timed-out SDK HEAD destroys its actual local HTTP socket', async () => {
  let resolveRequestSeen: (() => void) | undefined;
  let resolveSocketClosed: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => { resolveRequestSeen = resolve; });
  const socketClosed = new Promise<void>((resolve) => { resolveSocketClosed = resolve; });
  const server = createServer((request) => {
    request.socket.once('close', () => resolveSocketClosed?.());
    resolveRequestSeen?.();
  });
  const originalHeadTimeout = env.PDF_RETENTION_HEAD_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  env.PDF_RETENTION_HEAD_TIMEOUT_MS = 50;

  try {
    const storage = new StorageService(undefined, () => createPdfOperationClient({
      endPoint: '127.0.0.1',
      port: address.port,
    }));
    await assert.rejects(
      storage.pdfExists('invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf'),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'PDF_HEAD_TIMEOUT');
        return true;
      },
    );
    await Promise.race([
      requestSeen,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('SDK did not issue HEAD')), 1000)),
    ]);
    await Promise.race([
      socketClosed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('HTTP socket was not cancelled')), 1000)),
    ]);
  } finally {
    env.PDF_RETENTION_HEAD_TIMEOUT_MS = originalHeadTimeout;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('timed-out SDK PUT and DELETE destroy their actual local HTTP sockets', async () => {
  const methodsSeen = new Set<string>();
  const closedMethods = new Set<string>();
  const resolveSeen = new Map<string, () => void>();
  const resolveClosed = new Map<string, () => void>();
  const requestPromises = new Map<string, Promise<void>>();
  const closePromises = new Map<string, Promise<void>>();
  for (const method of ['PUT', 'DELETE']) {
    requestPromises.set(method, new Promise<void>((resolve) => resolveSeen.set(method, resolve)));
    closePromises.set(method, new Promise<void>((resolve) => resolveClosed.set(method, resolve)));
  }
  const server = createServer((request, response) => {
    request.socket.once('close', () => {
      closedMethods.add(request.method ?? '');
      resolveClosed.get(request.method ?? '')?.();
    });
    if (request.method === 'HEAD') {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end('<LocationConstraint>us-east-1</LocationConstraint>');
      return;
    }
    methodsSeen.add(request.method ?? '');
    resolveSeen.get(request.method ?? '')?.();
  });
  const originalUploadTimeout = env.PDF_UPLOAD_TIMEOUT_MS;
  const originalDeleteTimeout = env.PDF_RETENTION_DELETE_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  env.PDF_UPLOAD_TIMEOUT_MS = 500;
  env.PDF_RETENTION_DELETE_TIMEOUT_MS = 500;

  try {
    const createClient = () => {
      const operation = createPdfOperationClient({
        endPoint: '127.0.0.1',
        port: address.port,
      });
      operation.client.bucketExists = async () => true;
      return operation;
    };
    const storage = new StorageService(createClient, createClient);
    await assert.rejects(
      storage.uploadPdf('shop-1/react-print-v21/INV-1-123456789-123abc.pdf', Buffer.from('%PDF')),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'PDF_UPLOAD_TIMEOUT');
        return true;
      },
    );
    await assert.rejects(
      storage.deletePdf('invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf'),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'PDF_DELETE_TIMEOUT');
        return true;
      },
    );

    for (const method of ['PUT', 'DELETE']) {
      const requestSeen = requestPromises.get(method);
      const socketClosed = closePromises.get(method);
      assert.ok(requestSeen);
      assert.ok(socketClosed);
      await Promise.race([
        requestSeen,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`SDK did not issue ${method}; observed ${[...methodsSeen].join(',')}`)), 1000)),
      ]);
      await Promise.race([
        socketClosed,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`${method} HTTP socket was not cancelled`)), 1000)),
      ]);
      assert.equal(methodsSeen.has(method), true);
      assert.equal(closedMethods.has(method), true);
    }
  } finally {
    env.PDF_UPLOAD_TIMEOUT_MS = originalUploadTimeout;
    env.PDF_RETENTION_DELETE_TIMEOUT_MS = originalDeleteTimeout;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('pdfExists checks only recognized generated PDF object references', async () => {
  const inspected: Array<{ bucket: string; key: string }> = [];
  const client = {
    statObject: async (bucket: string, key: string) => {
      inspected.push({ bucket, key });
      return {} as Awaited<ReturnType<PdfClient['statObject']>>;
    },
  } as unknown as PdfClient;
  const storage = createStorageWithOperationClient(client);
  const ref = 'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf';
  assert.equal(await storage.pdfExists(ref), true);
  assert.deepEqual(inspected, [{
    bucket: s3Config.pdfBucket,
    key: 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
  }]);
  await assert.rejects(storage.pdfExists('invoice-pdfs/payment-slips/invoice.pdf'));
  assert.equal(inspected.length, 1);
});

test('pdfExists distinguishes a missing object from storage errors', async () => {
  let errorToThrow: Error & { code?: string; statusCode?: number } = Object.assign(new Error('missing object'), {
    code: 'NotFound',
  });
  const client = {
    statObject: async () => { throw errorToThrow; },
  } as unknown as PdfClient;
  const storage = createStorageWithOperationClient(client);
  const ref = 'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf';
  assert.equal(await storage.pdfExists(ref), false);
  errorToThrow = Object.assign(new Error('missing object'), { statusCode: 404 });
  assert.equal(await storage.pdfExists(ref), false);
  errorToThrow = Object.assign(new Error('storage unavailable'), { code: 'ECONNREFUSED' });
  await assert.rejects(storage.pdfExists(ref), /storage unavailable/);
});

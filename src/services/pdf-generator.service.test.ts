import assert from 'node:assert/strict';
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
process.env.FRONTEND_BASE_URL = 'http://localhost:5173';

import type { BrowserContext } from 'puppeteer';
import logger from '@/utils/logger';
import pdfBrowserService from '@/services/pdf-browser.service';
import { InvoicePdfPayload, PdfGeneratorService } from '@/services/pdf-generator.service';

test('invoice PDF renderer never logs or returns its tokenized print URL', async () => {
  const originalCreateContext = pdfBrowserService.createContext;
  const originalReleaseContext = pdfBrowserService.releaseContext;
  const originalLoggerError = logger.error;
  const originalLoggerInfo = logger.info;
  const capturedLogs: unknown[] = [];
  const handlers = new Map<string, (value: unknown) => void>();
  const fakePage = {
    on: (event: string, handler: (value: unknown) => void) => {
      handlers.set(event, handler);
    },
    setViewport: async () => undefined,
    goto: async (url: string) => {
      handlers.get('requestfailed')?.({
        method: () => 'GET',
        url: () => url,
        failure: () => ({ errorText: 'net::ERR_ABORTED' }),
      });
      handlers.get('response')?.({ url: () => url, status: () => 500 });
      throw new Error(`Navigation failed for ${url}`);
    },
  };
  const fakeContext = { newPage: async () => fakePage } as unknown as BrowserContext;
  pdfBrowserService.createContext = async () => fakeContext;
  pdfBrowserService.releaseContext = async () => undefined;
  logger.error = ((...args: unknown[]) => { capturedLogs.push(args); }) as typeof logger.error;
  logger.info = ((...args: unknown[]) => { capturedLogs.push(args); }) as typeof logger.info;

  try {
    const payload = {
      invoiceId: 'invoice-1',
      invoiceNumber: 'INV-1',
      customerId: 'customer-1',
    } as InvoicePdfPayload;
    await assert.rejects(
      new PdfGeneratorService().renderInvoicePdf(payload),
      (error: Error) => {
        assert.match(error.message, /Invoice print navigation failed \(Error\)/);
        assert.doesNotMatch(error.message, /token=|localhost:5173/);
        return true;
      },
    );
    assert.doesNotMatch(JSON.stringify(capturedLogs), /token=|localhost:5173/);
  } finally {
    pdfBrowserService.createContext = originalCreateContext;
    pdfBrowserService.releaseContext = originalReleaseContext;
    logger.error = originalLoggerError;
    logger.info = originalLoggerInfo;
  }
});

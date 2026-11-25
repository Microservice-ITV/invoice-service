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
process.env.PDF_RETENTION_DAYS = '7';
process.env.PDF_RETENTION_DRY_RUN = 'true';

import { PdfArtifactKind, type PdfArtifact } from '@prisma/client';
import env from '@/config/env';
import prisma from '@/config/database';
import storageService from '@/services/storage.service';
import { isPdfArtifactExpired, PdfRetentionService } from '@/services/pdf-retention.service';

const makeArtifact = (generatedAt: Date, status: PdfArtifact['status'] = 'READY'): PdfArtifact => ({
  id: 'artifact-1',
  kind: PdfArtifactKind.INVOICE_A4,
  sourceId: 'invoice-1',
  width: 'A4',
  artifactRef: 'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
  status,
  generatedAt,
  cleanupToken: null,
  cleanupLeaseUntil: null,
  createdAt: generatedAt,
  updatedAt: generatedAt,
});

test('PDF expiration uses the configured retention boundary', () => {
  const now = new Date('2026-11-30T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  assert.equal(isPdfArtifactExpired(cutoff, now, 7), true);
  assert.equal(isPdfArtifactExpired(new Date(cutoff.getTime() + 1), now, 7), false);
});

test('candidate recovery ordering lets rechecked missing upload intents yield to older updates', async () => {
  const originalFindMany = prisma.pdfArtifact.findMany;
  let orderBy: unknown;
  prisma.pdfArtifact.findMany = (async (args: { orderBy: unknown }) => {
    orderBy = args.orderBy;
    return [];
  }) as unknown as typeof prisma.pdfArtifact.findMany;

  try {
    await new PdfRetentionService().runOnce(new Date('2026-11-24T00:00:00.000Z'));
    assert.deepEqual(orderBy, [
      { updatedAt: 'asc' },
      { generatedAt: 'asc' },
      { id: 'asc' },
    ]);
  } finally {
    prisma.pdfArtifact.findMany = originalFindMany;
  }
});

test('PDF upload intent is recorded before storage upload and marked ready afterward', async () => {
  const originalCreate = prisma.pdfArtifact.create;
  const originalUpdate = prisma.pdfArtifact.updateMany;
  const originalUpload = storageService.uploadPdf;
  const operations: string[] = [];
  const artifactRef = 'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf';
  prisma.pdfArtifact.create = (async ({ data }: { data: Record<string, unknown> }) => {
    operations.push('intent');
    assert.equal(data.status, 'UPLOADING');
    assert.equal(data.artifactRef, artifactRef);
    return { ...makeArtifact(new Date(), 'UPLOADING'), id: 'intent-1', artifactRef };
  }) as unknown as typeof prisma.pdfArtifact.create;
  prisma.pdfArtifact.updateMany = (async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    operations.push('ready');
    assert.deepEqual(where, { id: 'intent-1', artifactRef, status: 'UPLOADING' });
    assert.equal(data.status, 'READY');
    return { count: 1 };
  }) as unknown as typeof prisma.pdfArtifact.updateMany;
  storageService.uploadPdf = async (fileName) => {
    operations.push('upload');
    assert.equal(fileName, 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf');
    return artifactRef;
  };

  try {
    const result = await new PdfRetentionService().uploadTrackedPdf({
      kind: PdfArtifactKind.INVOICE_A4,
      sourceId: 'invoice-1',
      width: 'A4',
      fileName: 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
      buffer: Buffer.from('%PDF'),
    });
    assert.equal(result, artifactRef);
    assert.deepEqual(operations, ['intent', 'upload', 'ready']);
  } finally {
    prisma.pdfArtifact.create = originalCreate;
    prisma.pdfArtifact.updateMany = originalUpdate;
    storageService.uploadPdf = originalUpload;
  }
});

test('intent database failure prevents any PDF storage upload', async () => {
  const originalCreate = prisma.pdfArtifact.create;
  const originalUpload = storageService.uploadPdf;
  let uploadCalls = 0;
  prisma.pdfArtifact.create = (async () => {
    throw new Error('Database unavailable');
  }) as unknown as typeof prisma.pdfArtifact.create;
  storageService.uploadPdf = async () => {
    uploadCalls += 1;
    return 'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf';
  };

  try {
    await assert.rejects(new PdfRetentionService().uploadTrackedPdf({
      kind: PdfArtifactKind.INVOICE_A4,
      sourceId: 'invoice-1',
      width: 'A4',
      fileName: 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
      buffer: Buffer.from('%PDF'),
    }));
    assert.equal(uploadCalls, 0);
  } finally {
    prisma.pdfArtifact.create = originalCreate;
    storageService.uploadPdf = originalUpload;
  }
});

test('ambiguous PDF upload timeout keeps the upload intent after successful compensation', async () => {
  const originals = {
    create: prisma.pdfArtifact.create,
    update: prisma.pdfArtifact.updateMany,
    delete: prisma.pdfArtifact.deleteMany,
    upload: storageService.uploadPdf,
    deletePdf: storageService.deletePdf,
  };
  let readyUpdates = 0;
  let intentDeletes = 0;
  let objectDeletes = 0;
  prisma.pdfArtifact.create = (async () => makeArtifact(new Date(), 'UPLOADING')) as unknown as typeof prisma.pdfArtifact.create;
  prisma.pdfArtifact.updateMany = (async ({ data }: { data: Record<string, unknown> }) => {
    if (data.status === 'READY') readyUpdates += 1;
    return { count: 1 };
  }) as unknown as typeof prisma.pdfArtifact.updateMany;
  prisma.pdfArtifact.deleteMany = (async () => {
    intentDeletes += 1;
    return { count: 1 };
  }) as unknown as typeof prisma.pdfArtifact.deleteMany;
  storageService.uploadPdf = async () => {
    throw Object.assign(new Error('PDF upload timed out with an ambiguous outcome'), {
      code: 'PDF_UPLOAD_TIMEOUT',
    });
  };
  storageService.deletePdf = async () => {
    objectDeletes += 1;
  };

  try {
    await assert.rejects(
      new PdfRetentionService().uploadTrackedPdf({
        kind: PdfArtifactKind.INVOICE_A4,
        sourceId: 'invoice-1',
        width: 'A4',
        fileName: 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
        buffer: Buffer.from('%PDF'),
      }),
      (error: Error & { code?: string }) => error.code === 'PDF_UPLOAD_TIMEOUT',
    );
    assert.equal(readyUpdates, 0);
    assert.equal(objectDeletes, 1);
    assert.equal(intentDeletes, 0);
  } finally {
    prisma.pdfArtifact.create = originals.create;
    prisma.pdfArtifact.updateMany = originals.update;
    prisma.pdfArtifact.deleteMany = originals.delete;
    storageService.uploadPdf = originals.upload;
    storageService.deletePdf = originals.deletePdf;
  }
});

test('READY update failure keeps the intent after compensation so late PUT completion remains recoverable', async () => {
  const originals = {
    create: prisma.pdfArtifact.create,
    update: prisma.pdfArtifact.updateMany,
    delete: prisma.pdfArtifact.deleteMany,
    upload: storageService.uploadPdf,
    deletePdf: storageService.deletePdf,
  };
  let intentDeletes = 0;
  let objectDeletes = 0;
  let updates = 0;
  prisma.pdfArtifact.create = (async () => makeArtifact(new Date(), 'UPLOADING')) as unknown as typeof prisma.pdfArtifact.create;
  prisma.pdfArtifact.updateMany = (async ({ data }: { data: Record<string, unknown> }) => {
    updates += 1;
    return { count: data.status === 'READY' ? 0 : 1 };
  }) as unknown as typeof prisma.pdfArtifact.updateMany;
  prisma.pdfArtifact.deleteMany = (async () => {
    intentDeletes += 1;
    return { count: 1 };
  }) as unknown as typeof prisma.pdfArtifact.deleteMany;
  storageService.uploadPdf = async (fileName) => `invoice-pdfs/${fileName}`;
  storageService.deletePdf = async () => {
    objectDeletes += 1;
  };

  try {
    await assert.rejects(new PdfRetentionService().uploadTrackedPdf({
      kind: PdfArtifactKind.INVOICE_A4,
      sourceId: 'invoice-1',
      width: 'A4',
      fileName: 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
      buffer: Buffer.from('%PDF'),
    }));
    assert.equal(objectDeletes, 1);
    assert.equal(intentDeletes, 0);
    assert.equal(updates, 2);
  } finally {
    prisma.pdfArtifact.create = originals.create;
    prisma.pdfArtifact.updateMany = originals.update;
    prisma.pdfArtifact.deleteMany = originals.delete;
    storageService.uploadPdf = originals.upload;
    storageService.deletePdf = originals.deletePdf;
  }
});

test('all generated invoice and receipt PDF kinds persist their intended upload metadata', async () => {
  const originalCreate = prisma.pdfArtifact.create;
  const originalUpdate = prisma.pdfArtifact.updateMany;
  const originalUpload = storageService.uploadPdf;
  const creates: Array<Record<string, unknown>> = [];
  prisma.pdfArtifact.create = (async ({ data }: { data: Record<string, unknown> }) => {
    creates.push(data);
    return { ...makeArtifact(new Date(), 'UPLOADING'), ...data } as PdfArtifact;
  }) as unknown as typeof prisma.pdfArtifact.create;
  prisma.pdfArtifact.updateMany = (async () => ({ count: 1 })) as unknown as typeof prisma.pdfArtifact.updateMany;
  storageService.uploadPdf = async (fileName) => `invoice-pdfs/${fileName}`;

  const cases = [
    { kind: PdfArtifactKind.INVOICE_A4, sourceId: 'invoice-1', width: 'A4' as const, fileName: 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf' },
    { kind: PdfArtifactKind.INVOICE_THERMAL, sourceId: 'invoice-1', width: '58mm' as const, fileName: 'thermal/shop-1/INV-1/58mm/12345678-1234-1234-1234-123456789abc.pdf' },
    { kind: PdfArtifactKind.RECEIPT_PDF, sourceId: 'receipt-1', width: '80mm' as const, fileName: 'receipts/shop-1/receipt-v1/RCP-1-123456789-123abc.pdf' },
    { kind: PdfArtifactKind.RECEIPT_THERMAL, sourceId: 'receipt-1', width: '80mm' as const, fileName: 'thermal/receipts/shop-1/RCP-1/80mm/12345678-1234-1234-1234-123456789abc.pdf' },
  ];

  try {
    for (const input of cases) {
      await new PdfRetentionService().uploadTrackedPdf({ ...input, buffer: Buffer.from('%PDF') });
    }
    assert.deepEqual(creates.map(({ kind, sourceId, width, status }) => ({ kind, sourceId, width, status })), cases.map(({ kind, sourceId, width }) => ({
      kind, sourceId, width, status: 'UPLOADING',
    })));
  } finally {
    prisma.pdfArtifact.create = originalCreate;
    prisma.pdfArtifact.updateMany = originalUpdate;
    storageService.uploadPdf = originalUpload;
  }
});

test('active uploads are protected from cleanup beyond the recovery grace period', async () => {
  const originals = {
    dryRun: env.PDF_RETENTION_DRY_RUN,
    create: prisma.pdfArtifact.create,
    update: prisma.pdfArtifact.updateMany,
    findArtifacts: prisma.pdfArtifact.findMany,
    findInvoices: prisma.invoice.findMany,
    findReceipts: prisma.receipt.findMany,
    findJobs: prisma.thermalPdfJob.findMany,
    transaction: prisma.$transaction,
    upload: storageService.uploadPdf,
    delete: storageService.deletePdf,
  };
  const now = new Date();
  const artifactRef = 'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf';
  const artifact = { ...makeArtifact(now, 'UPLOADING'), id: 'active-upload', artifactRef };
  let releaseUpload: ((value: string) => void) | undefined;
  let uploadStarted: (() => void) | undefined;
  const uploadPending = new Promise<string>((resolve) => { releaseUpload = resolve; });
  const uploadStartedSignal = new Promise<void>((resolve) => { uploadStarted = resolve; });
  let deleteCalls = 0;
  let transactionCalls = 0;
  env.PDF_RETENTION_DRY_RUN = false;
  prisma.pdfArtifact.create = (async () => artifact) as unknown as typeof prisma.pdfArtifact.create;
  prisma.pdfArtifact.updateMany = (async () => ({ count: 1 })) as unknown as typeof prisma.pdfArtifact.updateMany;
  prisma.pdfArtifact.findMany = (async () => [{
    ...artifact,
    generatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    updatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
  }]) as typeof prisma.pdfArtifact.findMany;
  prisma.invoice.findMany = (async () => []) as typeof prisma.invoice.findMany;
  prisma.receipt.findMany = (async () => []) as typeof prisma.receipt.findMany;
  prisma.thermalPdfJob.findMany = (async () => []) as typeof prisma.thermalPdfJob.findMany;
  (prisma as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> }).$transaction = async () => {
    transactionCalls += 1;
    throw new Error('Active upload must not be claimed for cleanup');
  };
  storageService.uploadPdf = async () => {
    uploadStarted?.();
    return uploadPending;
  };
  storageService.deletePdf = async () => {
    deleteCalls += 1;
  };
  const service = new PdfRetentionService();

  try {
    const uploadResult = service.uploadTrackedPdf({
      kind: PdfArtifactKind.INVOICE_A4,
      sourceId: 'invoice-1',
      width: 'A4',
      fileName: 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
      buffer: Buffer.from('%PDF'),
    });
    await uploadStartedSignal;
    await service.runOnce(new Date(now.getTime() + 2 * 60 * 60 * 1000));
    assert.equal(transactionCalls, 0);
    assert.equal(deleteCalls, 0);
    releaseUpload?.(artifactRef);
    assert.equal(await uploadResult, artifactRef);
  } finally {
    releaseUpload?.(artifactRef);
    env.PDF_RETENTION_DRY_RUN = originals.dryRun;
    prisma.pdfArtifact.create = originals.create;
    prisma.pdfArtifact.updateMany = originals.update;
    prisma.pdfArtifact.findMany = originals.findArtifacts;
    prisma.invoice.findMany = originals.findInvoices;
    prisma.receipt.findMany = originals.findReceipts;
    prisma.thermalPdfJob.findMany = originals.findJobs;
    (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = originals.transaction;
    storageService.uploadPdf = originals.upload;
    storageService.deletePdf = originals.delete;
  }
});

test('UPLOADING cleanup eligibility uses the exact one-hour updatedAt boundary', async () => {
  const originalFind = prisma.pdfArtifact.findMany;
  const now = new Date('2026-11-30T12:00:00.000Z');
  let where: Record<string, unknown> | undefined;
  prisma.pdfArtifact.findMany = (async (args: Record<string, unknown>) => {
    where = args.where as Record<string, unknown>;
    return [];
  }) as typeof prisma.pdfArtifact.findMany;

  try {
    await new PdfRetentionService().runOnce(now);
    const branches = (where?.OR ?? []) as Array<Record<string, unknown>>;
    assert.deepEqual(branches[1], {
      status: 'CLEANING',
      OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }],
    });
    assert.deepEqual(branches[2], {
      status: 'UPLOADING',
      updatedAt: { lte: new Date(now.getTime() - 60 * 60 * 1000) },
    });
  } finally {
    prisma.pdfArtifact.findMany = originalFind;
  }
});

test('stale upload intents are retained while their object is not yet visible in storage', async () => {
  const originals = {
    dryRun: env.PDF_RETENTION_DRY_RUN,
    findArtifacts: prisma.pdfArtifact.findMany,
    updateArtifacts: prisma.pdfArtifact.updateMany,
    findInvoices: prisma.invoice.findMany,
    findReceipts: prisma.receipt.findMany,
    findJobs: prisma.thermalPdfJob.findMany,
    transaction: prisma.$transaction,
    pdfExists: storageService.pdfExists,
    deletePdf: storageService.deletePdf,
  };
  const now = new Date('2026-11-30T12:00:00.000Z');
  const artifact = {
    ...makeArtifact(new Date(now.getTime() - 2 * 60 * 60 * 1000), 'UPLOADING'),
    id: 'outage-upload',
    updatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
  };
  let existenceChecks = 0;
  let timestampRefresh: { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;
  let transactionCalls = 0;
  let deletionCalls = 0;
  env.PDF_RETENTION_DRY_RUN = false;
  prisma.pdfArtifact.findMany = (async () => [artifact]) as typeof prisma.pdfArtifact.findMany;
  prisma.pdfArtifact.updateMany = (async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    timestampRefresh = args;
    return { count: 1 };
  }) as unknown as typeof prisma.pdfArtifact.updateMany;
  prisma.invoice.findMany = (async () => []) as typeof prisma.invoice.findMany;
  prisma.receipt.findMany = (async () => []) as typeof prisma.receipt.findMany;
  prisma.thermalPdfJob.findMany = (async () => []) as typeof prisma.thermalPdfJob.findMany;
  (prisma as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> }).$transaction = async () => {
    transactionCalls += 1;
    throw new Error('An incomplete upload must not be claimed');
  };
  storageService.pdfExists = async () => {
    existenceChecks += 1;
    return false;
  };
  storageService.deletePdf = async () => {
    deletionCalls += 1;
  };

  try {
    await new PdfRetentionService().runOnce(now);
    assert.equal(existenceChecks, 1);
    assert.deepEqual(timestampRefresh, {
      where: {
        id: artifact.id,
        artifactRef: artifact.artifactRef,
        status: 'UPLOADING',
        updatedAt: artifact.updatedAt,
      },
      data: { updatedAt: now },
    });
    assert.equal(transactionCalls, 0);
    assert.equal(deletionCalls, 0);
  } finally {
    env.PDF_RETENTION_DRY_RUN = originals.dryRun;
    prisma.pdfArtifact.findMany = originals.findArtifacts;
    prisma.pdfArtifact.updateMany = originals.updateArtifacts;
    prisma.invoice.findMany = originals.findInvoices;
    prisma.receipt.findMany = originals.findReceipts;
    prisma.thermalPdfJob.findMany = originals.findJobs;
    (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = originals.transaction;
    storageService.pdfExists = originals.pdfExists;
    storageService.deletePdf = originals.deletePdf;
  }
});

test('failed object deletion leaves an upload intent that retention cleanup can recover', async () => {
  const originals = {
    dryRun: env.PDF_RETENTION_DRY_RUN,
    create: prisma.pdfArtifact.create,
    update: prisma.pdfArtifact.updateMany,
    findArtifacts: prisma.pdfArtifact.findMany,
    findInvoices: prisma.invoice.findMany,
    findJobs: prisma.thermalPdfJob.findMany,
    transaction: prisma.$transaction,
    upload: storageService.uploadPdf,
    delete: storageService.deletePdf,
    pdfExists: storageService.pdfExists,
  };
  const startedAt = new Date('2026-11-30T00:00:00.000Z');
  const artifactRef = 'invoice-pdfs/shop-1/react-print-v21/INV-1-123456789-123abc.pdf';
  const intent = { ...makeArtifact(startedAt, 'UPLOADING'), id: 'orphan-intent', artifactRef };
  let updateCalls = 0;
  let deleteCalls = 0;
  let candidateQuery: Record<string, unknown> | undefined;
  env.PDF_RETENTION_DRY_RUN = false;
  prisma.pdfArtifact.create = (async () => intent) as typeof prisma.pdfArtifact.create;
  prisma.pdfArtifact.updateMany = (async () => {
    updateCalls += 1;
    return { count: updateCalls === 1 ? 0 : 1 };
  }) as typeof prisma.pdfArtifact.updateMany;
  storageService.uploadPdf = async () => artifactRef;
  storageService.pdfExists = async () => true;
  storageService.deletePdf = async () => {
    deleteCalls += 1;
    if (deleteCalls === 1) throw new Error('Temporary object-store failure');
  };
  prisma.pdfArtifact.findMany = (async (args: Record<string, unknown>) => {
    candidateQuery = args.where as Record<string, unknown>;
    return [{
      ...intent,
      generatedAt: new Date(startedAt.getTime() - 2 * 60 * 60 * 1000),
      updatedAt: new Date(startedAt.getTime() - 2 * 60 * 60 * 1000),
    }];
  }) as typeof prisma.pdfArtifact.findMany;
  prisma.invoice.findMany = (async () => []) as typeof prisma.invoice.findMany;
  prisma.thermalPdfJob.findMany = (async () => []) as typeof prisma.thermalPdfJob.findMany;
  const transactionMock = async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback({
    pdfArtifact: {
      updateMany: async () => ({ count: 1 }),
      deleteMany: async () => ({ count: 1 }),
    },
    invoice: { updateMany: async () => ({ count: 1 }) },
    receipt: { updateMany: async () => ({ count: 1 }) },
    thermalPdfJob: { updateMany: async () => ({ count: 1 }) },
  });
  (prisma as unknown as { $transaction: typeof transactionMock }).$transaction = transactionMock;

  try {
    await assert.rejects(new PdfRetentionService().uploadTrackedPdf({
      kind: PdfArtifactKind.INVOICE_A4,
      sourceId: 'invoice-1',
      width: 'A4',
      fileName: 'shop-1/react-print-v21/INV-1-123456789-123abc.pdf',
      buffer: Buffer.from('%PDF'),
    }));
    assert.equal(updateCalls, 2);

    await new PdfRetentionService().runOnce(new Date(startedAt.getTime() + 2 * 60 * 60 * 1000));

    const candidateBranches = (candidateQuery?.OR ?? []) as Array<Record<string, unknown>>;
    assert.ok(candidateBranches.some((branch) => branch.status === 'UPLOADING' && 'updatedAt' in branch));
    assert.equal(deleteCalls, 2);
  } finally {
    env.PDF_RETENTION_DRY_RUN = originals.dryRun;
    prisma.pdfArtifact.create = originals.create;
    prisma.pdfArtifact.updateMany = originals.update;
    prisma.pdfArtifact.findMany = originals.findArtifacts;
    prisma.invoice.findMany = originals.findInvoices;
    prisma.thermalPdfJob.findMany = originals.findJobs;
    (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = originals.transaction;
    storageService.uploadPdf = originals.upload;
    storageService.deletePdf = originals.delete;
    storageService.pdfExists = originals.pdfExists;
  }
});

test('dry-run discovers expired references without claiming or deleting them', async () => {
  const originals = {
    dryRun: env.PDF_RETENTION_DRY_RUN,
    findArtifacts: prisma.pdfArtifact.findMany,
    findInvoices: prisma.invoice.findMany,
    findJobs: prisma.thermalPdfJob.findMany,
    transaction: prisma.$transaction,
    deletePdf: storageService.deletePdf,
  };
  let transactionCalls = 0;
  let deletionCalls = 0;
  const now = new Date('2026-11-30T00:00:00.000Z');
  env.PDF_RETENTION_DRY_RUN = true;
  prisma.pdfArtifact.findMany = (async () => [makeArtifact(new Date('2026-11-01T00:00:00.000Z'))]) as typeof prisma.pdfArtifact.findMany;
  prisma.invoice.findMany = (async () => [{
    id: 'invoice-1',
    pdfUrl: makeArtifact(now).artifactRef,
    pdfStatus: 'READY',
    pdfCleanupLeaseUntil: null,
  }]) as typeof prisma.invoice.findMany;
  prisma.thermalPdfJob.findMany = (async () => []) as typeof prisma.thermalPdfJob.findMany;
  (prisma as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> }).$transaction = async () => {
    transactionCalls += 1;
    throw new Error('Dry run must not mutate the database');
  };
  storageService.deletePdf = async () => {
    deletionCalls += 1;
  };

  try {
    await new PdfRetentionService().runOnce(now);
    assert.equal(transactionCalls, 0);
    assert.equal(deletionCalls, 0);
  } finally {
    env.PDF_RETENTION_DRY_RUN = originals.dryRun;
    prisma.pdfArtifact.findMany = originals.findArtifacts;
    prisma.invoice.findMany = originals.findInvoices;
    prisma.thermalPdfJob.findMany = originals.findJobs;
    (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = originals.transaction;
    storageService.deletePdf = originals.deletePdf;
  }
});

test('cleanup deletes first, then clears only the matching source and artifact references', async () => {
  const originals = {
    dryRun: env.PDF_RETENTION_DRY_RUN,
    findArtifacts: prisma.pdfArtifact.findMany,
    findInvoices: prisma.invoice.findMany,
    findJobs: prisma.thermalPdfJob.findMany,
    transaction: prisma.$transaction,
    deletePdf: storageService.deletePdf,
  };
  const now = new Date('2026-11-30T00:00:00.000Z');
  const artifact = makeArtifact(new Date('2026-11-01T00:00:00.000Z'));
  const operations: string[] = [];
  env.PDF_RETENTION_DRY_RUN = false;
  prisma.pdfArtifact.findMany = (async () => [artifact]) as typeof prisma.pdfArtifact.findMany;
  prisma.invoice.findMany = (async () => [{
    id: artifact.sourceId,
    pdfUrl: artifact.artifactRef,
    pdfStatus: 'READY',
    pdfCleanupLeaseUntil: null,
  }]) as typeof prisma.invoice.findMany;
  prisma.thermalPdfJob.findMany = (async () => []) as typeof prisma.thermalPdfJob.findMany;
  storageService.deletePdf = async (ref) => {
    assert.equal(ref, artifact.artifactRef);
    operations.push('delete');
  };

  const transactionMock = async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const tx = {
      pdfArtifact: {
        updateMany: async () => {
          operations.push('claim-artifact');
          return { count: 1 };
        },
        deleteMany: async () => {
          operations.push('clear-artifact');
          return { count: 1 };
        },
      },
      invoice: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          if (data.pdfUrl === null) {
            operations.push('clear-invoice');
            assert.ok(operations.includes('delete'));
          }
          return { count: 1 };
        },
      },
      receipt: { updateMany: async () => ({ count: 1 }) },
      thermalPdfJob: { updateMany: async () => ({ count: 1 }) },
    };
    return callback(tx);
  };
  (prisma as unknown as { $transaction: typeof transactionMock }).$transaction = transactionMock;

  try {
    await new PdfRetentionService().runOnce(now);
    assert.deepEqual(operations, ['claim-artifact', 'delete', 'clear-invoice', 'clear-artifact']);
  } finally {
    env.PDF_RETENTION_DRY_RUN = originals.dryRun;
    prisma.pdfArtifact.findMany = originals.findArtifacts;
    prisma.invoice.findMany = originals.findInvoices;
    prisma.thermalPdfJob.findMany = originals.findJobs;
    (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = originals.transaction;
    storageService.deletePdf = originals.deletePdf;
  }
});

test('concurrent cleanup workers claim and delete a matching artifact only once', async () => {
  const originals = {
    dryRun: env.PDF_RETENTION_DRY_RUN,
    findArtifacts: prisma.pdfArtifact.findMany,
    findInvoices: prisma.invoice.findMany,
    findJobs: prisma.thermalPdfJob.findMany,
    transaction: prisma.$transaction,
    deletePdf: storageService.deletePdf,
  };
  const now = new Date('2026-11-30T00:00:00.000Z');
  const artifact = makeArtifact(new Date('2026-11-01T00:00:00.000Z'));
  const artifactState: Record<string, unknown> = { ...artifact };
  const invoiceState: Record<string, unknown> = {
    id: artifact.sourceId,
    pdfUrl: artifact.artifactRef,
    pdfStatus: 'READY',
    pdfUpdatedAt: artifact.generatedAt,
    pdfCleanupLeaseUntil: null,
    pdfCleanupToken: null,
  };
  let deleteCalls = 0;
  let artifactRemoved = false;
  env.PDF_RETENTION_DRY_RUN = false;
  prisma.pdfArtifact.findMany = (async () => [{ ...artifactState }]) as typeof prisma.pdfArtifact.findMany;
  prisma.invoice.findMany = (async () => [{ ...invoiceState }]) as typeof prisma.invoice.findMany;
  prisma.thermalPdfJob.findMany = (async () => []) as typeof prisma.thermalPdfJob.findMany;
  storageService.deletePdf = async () => {
    deleteCalls += 1;
  };

  const transactionMock = async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback({
    pdfArtifact: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const branches = (where.OR ?? []) as Array<Record<string, unknown>>;
        const canClaimReady = branches.some((branch) => branch.status === 'READY');
        const cleaningBranch = branches.find((branch) => branch.status === 'CLEANING');
        const leaseFilter = cleaningBranch?.OR as Array<Record<string, unknown>> | undefined;
        const leaseIsExpired = leaseFilter?.some((condition) => {
          const expiry = (condition.cleanupLeaseUntil as { lte?: Date } | null)?.lte;
          return condition.cleanupLeaseUntil === null || (expiry instanceof Date && expiry <= now);
        }) ?? false;
        if (where.id !== artifact.id || where.artifactRef !== artifact.artifactRef) return { count: 0 };
        if (artifactState.status !== 'READY' && !(artifactState.status === 'CLEANING' && leaseIsExpired)) return { count: 0 };
        if (artifactState.status !== 'READY' || !canClaimReady) return { count: 0 };
        Object.assign(artifactState, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        if (artifactState.status !== 'CLEANING' || where.cleanupToken !== artifactState.cleanupToken) return { count: 0 };
        artifactRemoved = true;
        return { count: 1 };
      },
    },
    invoice: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(invoiceState, data);
        return { count: 1 };
      },
    },
    receipt: { updateMany: async () => ({ count: 1 }) },
    thermalPdfJob: { updateMany: async () => ({ count: 1 }) },
  });
  (prisma as unknown as { $transaction: typeof transactionMock }).$transaction = transactionMock;

  try {
    await Promise.all([
      new PdfRetentionService().runOnce(now),
      new PdfRetentionService().runOnce(now),
    ]);
    assert.equal(deleteCalls, 1);
    assert.equal(artifactRemoved, true);
    assert.equal(invoiceState.pdfUrl, null);
  } finally {
    env.PDF_RETENTION_DRY_RUN = originals.dryRun;
    prisma.pdfArtifact.findMany = originals.findArtifacts;
    prisma.invoice.findMany = originals.findInvoices;
    prisma.thermalPdfJob.findMany = originals.findJobs;
    (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = originals.transaction;
    storageService.deletePdf = originals.deletePdf;
  }
});

test('a failed delete remains leased and is completed after the lease expires', async () => {
  const originals = {
    dryRun: env.PDF_RETENTION_DRY_RUN,
    retryLimit: env.PDF_RETENTION_RETRY_LIMIT,
    findArtifacts: prisma.pdfArtifact.findMany,
    findInvoices: prisma.invoice.findMany,
    findJobs: prisma.thermalPdfJob.findMany,
    transaction: prisma.$transaction,
    deletePdf: storageService.deletePdf,
  };
  const firstRun = new Date('2026-11-30T00:00:00.000Z');
  const artifact = makeArtifact(new Date('2026-11-01T00:00:00.000Z'));
  const artifactState: Record<string, unknown> = { ...artifact };
  const invoiceState: Record<string, unknown> = {
    id: artifact.sourceId,
    pdfUrl: artifact.artifactRef,
    pdfStatus: 'READY',
    pdfUpdatedAt: artifact.generatedAt,
    pdfCleanupLeaseUntil: null,
    pdfCleanupToken: null,
  };
  let deleteCalls = 0;
  env.PDF_RETENTION_DRY_RUN = false;
  env.PDF_RETENTION_RETRY_LIMIT = 1;
  prisma.pdfArtifact.findMany = (async () => [artifactState]) as typeof prisma.pdfArtifact.findMany;
  prisma.invoice.findMany = (async () => [{ ...invoiceState }]) as typeof prisma.invoice.findMany;
  prisma.thermalPdfJob.findMany = (async () => []) as typeof prisma.thermalPdfJob.findMany;
  storageService.deletePdf = async () => {
    deleteCalls += 1;
    if (deleteCalls === 1) throw new Error('Temporary object-store failure');
  };
  const transactionMock = async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback({
    pdfArtifact: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(artifactState, data);
        return { count: 1 };
      },
      deleteMany: async () => {
        artifactState.status = 'DELETED';
        return { count: 1 };
      },
    },
    invoice: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(invoiceState, data);
        return { count: 1 };
      },
    },
    receipt: { updateMany: async () => ({ count: 1 }) },
    thermalPdfJob: { updateMany: async () => ({ count: 1 }) },
  });
  (prisma as unknown as { $transaction: typeof transactionMock }).$transaction = transactionMock;

  try {
    const service = new PdfRetentionService();
    await service.runOnce(firstRun);
    assert.equal(artifactState.status, 'CLEANING');
    assert.equal(invoiceState.pdfStatus, 'CLEANING');
    assert.equal(invoiceState.pdfUrl, artifact.artifactRef);

    await service.runOnce(new Date(firstRun.getTime() + env.PDF_RETENTION_LEASE_MS + 1));
    assert.equal(deleteCalls, 2);
    assert.equal(artifactState.status, 'DELETED');
    assert.equal(invoiceState.pdfStatus, 'PENDING');
    assert.equal(invoiceState.pdfUrl, null);
  } finally {
    env.PDF_RETENTION_DRY_RUN = originals.dryRun;
    env.PDF_RETENTION_RETRY_LIMIT = originals.retryLimit;
    prisma.pdfArtifact.findMany = originals.findArtifacts;
    prisma.invoice.findMany = originals.findInvoices;
    prisma.thermalPdfJob.findMany = originals.findJobs;
    (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = originals.transaction;
    storageService.deletePdf = originals.deletePdf;
  }
});

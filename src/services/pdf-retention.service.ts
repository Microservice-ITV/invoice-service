import crypto from 'node:crypto';
import { PdfArtifact, PdfArtifactKind } from '@prisma/client';
import env from '@/config/env';
import prisma from '@/config/database';
import storageService from '@/services/storage.service';
import logger from '@/utils/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOADING_RECOVERY_GRACE_MS = 60 * 60 * 1000;
const UPLOADING_HEARTBEAT_MS = 5 * 60 * 1000;
const activeUploadRefs = new Set<string>();
const RETENTION_KINDS = new Set<PdfArtifactKind>([
  PdfArtifactKind.INVOICE_A4,
  PdfArtifactKind.INVOICE_THERMAL,
  PdfArtifactKind.RECEIPT_PDF,
  PdfArtifactKind.RECEIPT_THERMAL,
]);

type ArtifactInvoice = {
  id: string;
  pdfUrl: string | null;
  pdfStatus: string;
  pdfUpdatedAt: Date | null;
  pdfCleanupLeaseUntil: Date | null;
};

type ArtifactReceipt = {
  id: string;
  pdfUrl: string | null;
  pdfStatus: string;
  pdfUpdatedAt: Date | null;
  pdfCleanupLeaseUntil: Date | null;
};

type ArtifactJob = {
  id: string;
  invoiceId: string | null;
  receiptId: string | null;
  width: string;
  artifactRef: string | null;
  status: string;
  leaseUntil: Date | null;
  cleanupLeaseUntil: Date | null;
};

type Candidate = {
  artifact: PdfArtifact;
  invoice?: ArtifactInvoice;
  receipt?: ArtifactReceipt;
  job?: ArtifactJob;
};

type Claim = {
  token: string;
  invoiceClaimed: boolean;
  receiptClaimed: boolean;
  jobClaimed: boolean;
};

type RunSummary = {
  discovered: number;
  claimed: number;
  deleted: number;
  alreadyMissing: number;
  missingObjects: number;
  referencesCleared: number;
  failed: number;
  skipped: number;
  retries: number;
  uploadingCandidates: number;
  oldestUploadingAgeMs: number | null;
  expiredCleaningLeases: number;
  batchAtLimit: boolean;
};

class ClaimConflict extends Error {}

class ArtifactDeleteError extends Error {
  constructor(public readonly retries: number, public readonly originalError: unknown) {
    super('PDF object deletion failed after bounded retries');
  }
}

const isExpired = (generatedAt: Date, now: Date, retentionDays: number): boolean =>
  generatedAt.getTime() <= now.getTime() - retentionDays * DAY_MS;

const getErrorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const isMissingObject = (error: unknown): boolean => {
  const code = getErrorCode(error);
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number(error.statusCode)
    : undefined;
  return statusCode === 404 || ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(code ?? '');
};

const isLeaseExpired = (leaseUntil: Date | null, now: Date): boolean =>
  leaseUntil === null || leaseUntil.getTime() <= now.getTime();

export const isPdfArtifactExpired = isExpired;

export class PdfRetentionService {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;

  async uploadTrackedPdf(input: {
    kind: PdfArtifactKind;
    sourceId: string;
    width: 'A4' | '58mm' | '80mm';
    fileName: string;
    buffer: Buffer;
  }): Promise<string> {
    if (!RETENTION_KINDS.has(input.kind)) {
      throw new Error('Unsupported PDF artifact kind');
    }

    const generatedAt = new Date();
    const artifactRef = storageService.getPdfReference(input.fileName);
    const artifact = await prisma.pdfArtifact.create({
      data: {
        kind: input.kind,
        sourceId: input.sourceId,
        width: input.width,
        artifactRef,
        status: 'UPLOADING',
        generatedAt,
      },
    });

    activeUploadRefs.add(artifactRef);
    const heartbeat = setInterval(() => {
      void prisma.pdfArtifact.updateMany({
        where: { id: artifact.id, artifactRef, status: 'UPLOADING' },
        data: { updatedAt: new Date() },
      }).then((result) => {
        if (result.count !== 1) {
          logger.warn('PDF upload intent is no longer active during storage upload', {
            kind: input.kind,
            artifactId: artifact.id,
          });
        }
      }).catch((error: unknown) => {
        logger.warn('Could not refresh the active PDF upload intent', {
          kind: input.kind,
          artifactId: artifact.id,
          errorCode: getErrorCode(error),
        });
      });
    }, UPLOADING_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      try {
        const uploadedRef = await storageService.uploadPdf(input.fileName, input.buffer);
        if (uploadedRef !== artifactRef) throw new Error('PDF upload returned an unexpected artifact reference');
        const markedReady = await prisma.pdfArtifact.updateMany({
          where: { id: artifact.id, artifactRef, status: 'UPLOADING' },
          data: { status: 'READY', generatedAt },
        });
        if (markedReady.count !== 1) throw new Error('PDF upload intent could not be marked ready');
        return artifactRef;
      } catch (error) {
        logger.error('Failed to upload or register PDF artifact', {
          kind: input.kind,
          artifactId: artifact.id,
          errorCode: getErrorCode(error),
        });
        try {
          await storageService.deletePdf(artifactRef);
        } catch (cleanupError) {
          logger.error('Failed to remove a PDF artifact; upload intent retained for recovery', {
            kind: input.kind,
            artifactId: artifact.id,
            errorCode: getErrorCode(cleanupError),
          });
        }
        try {
          await prisma.pdfArtifact.updateMany({
            where: { id: artifact.id, artifactRef, status: { in: ['UPLOADING', 'READY'] } },
            data: { status: 'UPLOADING', generatedAt },
          });
        } catch (cleanupError) {
          logger.error('Could not refresh the retained PDF upload intent', {
            kind: input.kind,
            artifactId: artifact.id,
            errorCode: getErrorCode(cleanupError),
          });
        }
        throw error;
      }
    } finally {
      clearInterval(heartbeat);
      activeUploadRefs.delete(artifactRef);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, env.PDF_RETENTION_INTERVAL_MS);
    this.timer.unref?.();
    void this.runOnce();
    logger.info('PDF retention scheduler started', {
      intervalMs: env.PDF_RETENTION_INTERVAL_MS,
      retentionDays: env.PDF_RETENTION_DAYS,
      dryRun: env.PDF_RETENTION_DRY_RUN,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeRun;
    logger.info('PDF retention scheduler stopped');
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.activeRun) return this.activeRun;
    const run = this.executeRun(now);
    this.activeRun = run;
    try {
      await run;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  private async executeRun(now: Date): Promise<void> {
    const startedAt = Date.now();
    const cutoff = new Date(now.getTime() - env.PDF_RETENTION_DAYS * DAY_MS);
    const summary: RunSummary = {
      discovered: 0,
      claimed: 0,
      deleted: 0,
      alreadyMissing: 0,
      missingObjects: 0,
      referencesCleared: 0,
      failed: 0,
      skipped: 0,
      retries: 0,
      uploadingCandidates: 0,
      oldestUploadingAgeMs: null,
      expiredCleaningLeases: 0,
      batchAtLimit: false,
    };

    logger.info('PDF retention cleanup started', {
      cutoff: cutoff.toISOString(),
      retentionDays: env.PDF_RETENTION_DAYS,
      dryRun: env.PDF_RETENTION_DRY_RUN,
    });

    try {
      const candidates = await this.findCandidates(cutoff, now);
      summary.discovered = candidates.length;
      const uploadingCandidates = candidates.filter(({ artifact }) => artifact.status === 'UPLOADING');
      summary.uploadingCandidates = uploadingCandidates.length;
      if (uploadingCandidates.length > 0) {
        const oldestUploadCreatedAt = Math.min(...uploadingCandidates.map(({ artifact }) => artifact.createdAt.getTime()));
        summary.oldestUploadingAgeMs = Math.max(0, now.getTime() - oldestUploadCreatedAt);
      }
      summary.expiredCleaningLeases = candidates.filter(({ artifact }) => artifact.status === 'CLEANING').length;
      summary.batchAtLimit = candidates.length === env.PDF_RETENTION_BATCH_SIZE;
      if (env.PDF_RETENTION_DRY_RUN) {
        logger.info('PDF retention dry run completed', {
          ...summary,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      await this.forEachConcurrent(candidates, env.PDF_RETENTION_CONCURRENCY, async (candidate) => {
        try {
          if (candidate.artifact.status === 'UPLOADING'
            && !await storageService.pdfExists(candidate.artifact.artifactRef)) {
            summary.missingObjects += 1;
            await prisma.pdfArtifact.updateMany({
              where: {
                id: candidate.artifact.id,
                artifactRef: candidate.artifact.artifactRef,
                status: 'UPLOADING',
                updatedAt: candidate.artifact.updatedAt,
              },
              data: { updatedAt: now },
            });
            summary.skipped += 1;
            return;
          }
          const claim = await this.claim(candidate, cutoff, now);
          if (!claim) {
            summary.skipped += 1;
            return;
          }
          summary.claimed += 1;
          const deletion = await this.deleteWithRetries(candidate.artifact.artifactRef);
          summary.retries += deletion.retries;
          const cleared = await this.finalize(candidate, claim, now);
          summary.referencesCleared += cleared;
          if (deletion.alreadyMissing) summary.alreadyMissing += 1;
          else summary.deleted += 1;
        } catch (error) {
          summary.failed += 1;
          const retries = error instanceof ArtifactDeleteError ? error.retries : 0;
          summary.retries += retries;
          logger.error('PDF retention artifact cleanup failed', {
            artifactId: candidate.artifact.id,
            kind: candidate.artifact.kind,
            retries,
            errorCode: getErrorCode(error instanceof ArtifactDeleteError ? error.originalError : error),
          });
        }
      });
    } catch (error) {
      summary.failed += 1;
      logger.error('PDF retention cleanup run failed', {
        errorCode: getErrorCode(error),
      });
    }

    logger.info('PDF retention cleanup completed', {
      ...summary,
      durationMs: Date.now() - startedAt,
    });
  }

  private async findCandidates(cutoff: Date, now: Date): Promise<Candidate[]> {
    const uploadingCutoff = new Date(now.getTime() - UPLOADING_RECOVERY_GRACE_MS);
    const artifacts = await prisma.pdfArtifact.findMany({
      where: {
        OR: [
          { status: 'READY', generatedAt: { lte: cutoff } },
          {
            status: 'CLEANING',
            OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }],
          },
          { status: 'UPLOADING', updatedAt: { lte: uploadingCutoff } },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { generatedAt: 'asc' }, { id: 'asc' }],
      take: env.PDF_RETENTION_BATCH_SIZE,
    });
    if (artifacts.length === 0) return [];

    const invoiceArtifacts = artifacts.filter((item) =>
      item.kind === PdfArtifactKind.INVOICE_A4 || item.kind === PdfArtifactKind.INVOICE_THERMAL);
    const receiptArtifacts = artifacts.filter((item) =>
      item.kind === PdfArtifactKind.RECEIPT_PDF || item.kind === PdfArtifactKind.RECEIPT_THERMAL);
    const invoiceIds = [...new Set(invoiceArtifacts.map((item) => item.sourceId))];
    const receiptIds = [...new Set(receiptArtifacts.map((item) => item.sourceId))];
    const invoiceJobFilters = invoiceArtifacts
      .filter((item) => item.kind !== PdfArtifactKind.INVOICE_A4 || item.width === 'A4')
      .map((item) => ({
        invoiceId: item.sourceId,
        width: item.width,
        ...(item.status === 'UPLOADING' ? {} : { artifactRef: item.artifactRef }),
      }));
    const receiptJobFilters = receiptArtifacts
      .filter((item) => item.kind === PdfArtifactKind.RECEIPT_THERMAL)
      .map((item) => ({
        receiptId: item.sourceId,
        width: item.width,
        ...(item.status === 'UPLOADING' ? {} : { artifactRef: item.artifactRef }),
      }));

    const [invoices, receipts, invoiceJobs, receiptJobs] = await Promise.all([
      invoiceIds.length
        ? prisma.invoice.findMany({
          where: { id: { in: invoiceIds } },
          select: { id: true, pdfUrl: true, pdfStatus: true, pdfUpdatedAt: true, pdfCleanupLeaseUntil: true },
        })
        : Promise.resolve([]),
      receiptIds.length
        ? prisma.receipt.findMany({
          where: { id: { in: receiptIds } },
          select: { id: true, pdfUrl: true, pdfStatus: true, pdfUpdatedAt: true, pdfCleanupLeaseUntil: true },
        })
        : Promise.resolve([]),
      invoiceJobFilters.length
        ? prisma.thermalPdfJob.findMany({
          where: { OR: invoiceJobFilters },
          select: { id: true, invoiceId: true, receiptId: true, width: true, artifactRef: true, status: true, leaseUntil: true, cleanupLeaseUntil: true },
        })
        : Promise.resolve([]),
      receiptJobFilters.length
        ? prisma.thermalPdfJob.findMany({
          where: { OR: receiptJobFilters },
          select: { id: true, invoiceId: true, receiptId: true, width: true, artifactRef: true, status: true, leaseUntil: true, cleanupLeaseUntil: true },
        })
        : Promise.resolve([]),
    ]);

    const invoicesById = new Map(invoices.map((item) => [item.id, item as ArtifactInvoice]));
    const receiptsById = new Map(receipts.map((item) => [item.id, item as ArtifactReceipt]));
    const jobsByKey = new Map<string, ArtifactJob>();
    const jobsBySourceAndWidth = new Map<string, ArtifactJob>();
    for (const job of [...invoiceJobs, ...receiptJobs] as ArtifactJob[]) {
      const sourceId = job.invoiceId ?? job.receiptId;
      if (sourceId) {
        jobsByKey.set(`${sourceId}:${job.width}:${job.artifactRef}`, job);
        jobsBySourceAndWidth.set(`${sourceId}:${job.width}`, job);
      }
    }

    return artifacts.map((artifact) => {
      const exactJob = jobsByKey.get(`${artifact.sourceId}:${artifact.width}:${artifact.artifactRef}`);
      return {
        artifact,
        invoice: invoicesById.get(artifact.sourceId),
        receipt: receiptsById.get(artifact.sourceId),
        job: exactJob ?? (artifact.status === 'UPLOADING'
          ? jobsBySourceAndWidth.get(`${artifact.sourceId}:${artifact.width}`)
          : undefined),
      };
    });
  }

  private sourceIsBusy(candidate: Candidate, now: Date): boolean {
    const { artifact, invoice, receipt, job } = candidate;
    if (artifact.status === 'UPLOADING' && activeUploadRefs.has(artifact.artifactRef)) return true;
    const activePdfGeneration = (status: string, updatedAt: Date | null) =>
      status === 'GENERATING'
      && updatedAt !== null
      && updatedAt.getTime() > now.getTime() - UPLOADING_RECOVERY_GRACE_MS;
    if (artifact.kind === PdfArtifactKind.INVOICE_A4
      && (artifact.status === 'UPLOADING' || invoice?.pdfUrl === artifact.artifactRef)) {
      if (invoice) {
        if (activePdfGeneration(invoice.pdfStatus, invoice.pdfUpdatedAt)) return true;
        if (invoice.pdfStatus === 'CLEANING' && !isLeaseExpired(invoice.pdfCleanupLeaseUntil, now)) return true;
      }
    }
    if (artifact.kind === PdfArtifactKind.RECEIPT_PDF
      && (artifact.status === 'UPLOADING' || receipt?.pdfUrl === artifact.artifactRef)) {
      if (receipt) {
        if (activePdfGeneration(receipt.pdfStatus, receipt.pdfUpdatedAt)) return true;
        if (receipt.pdfStatus === 'CLEANING' && !isLeaseExpired(receipt.pdfCleanupLeaseUntil, now)) return true;
      }
    }
    if (job && (job.artifactRef === artifact.artifactRef || artifact.status === 'UPLOADING')) {
      if (job.status === 'PROCESSING'
        && (job.leaseUntil === null || job.leaseUntil.getTime() > now.getTime())) return true;
      if (job.status === 'CLEANING' && !isLeaseExpired(job.cleanupLeaseUntil, now)) return true;
    }
    return false;
  }

  private async claim(candidate: Candidate, cutoff: Date, now: Date): Promise<Claim | null> {
    if (this.sourceIsBusy(candidate, now)) return null;

    const token = crypto.randomUUID();
    const leaseUntil = new Date(now.getTime() + env.PDF_RETENTION_LEASE_MS);
    const uploadingCutoff = new Date(now.getTime() - UPLOADING_RECOVERY_GRACE_MS);
    try {
      return await prisma.$transaction(async (tx) => {
        const artifact = await tx.pdfArtifact.updateMany({
          where: {
            id: candidate.artifact.id,
            artifactRef: candidate.artifact.artifactRef,
            OR: [
              { status: 'READY', generatedAt: { lte: cutoff } },
              {
                status: 'CLEANING',
                OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }],
              },
              { status: 'UPLOADING', updatedAt: { lte: uploadingCutoff } },
            ],
          },
          data: { status: 'CLEANING', cleanupToken: token, cleanupLeaseUntil: leaseUntil },
        });
        if (artifact.count !== 1) throw new ClaimConflict();

        let invoiceClaimed = false;
        let receiptClaimed = false;
        let jobClaimed = false;

        if (candidate.artifact.kind === PdfArtifactKind.INVOICE_A4
          && candidate.invoice?.pdfUrl === candidate.artifact.artifactRef) {
          const invoice = await tx.invoice.updateMany({
            where: {
              id: candidate.artifact.sourceId,
              pdfUrl: candidate.artifact.artifactRef,
              OR: [
                { pdfStatus: { in: ['PENDING', 'READY', 'FAILED'] } },
                { pdfStatus: 'GENERATING', OR: [{ pdfUpdatedAt: null }, { pdfUpdatedAt: { lt: new Date(now.getTime() - 15 * 60 * 1000) } }] },
                { pdfStatus: 'CLEANING', OR: [{ pdfCleanupLeaseUntil: null }, { pdfCleanupLeaseUntil: { lte: now } }] },
              ],
            },
            data: { pdfStatus: 'CLEANING', pdfCleanupToken: token, pdfCleanupLeaseUntil: leaseUntil, pdfUpdatedAt: now },
          });
          if (invoice.count !== 1) throw new ClaimConflict();
          invoiceClaimed = true;
        }

        if (candidate.artifact.kind === PdfArtifactKind.RECEIPT_PDF
          && candidate.receipt?.pdfUrl === candidate.artifact.artifactRef) {
          const receipt = await tx.receipt.updateMany({
            where: {
              id: candidate.artifact.sourceId,
              pdfUrl: candidate.artifact.artifactRef,
              OR: [
                { pdfStatus: { in: ['PENDING', 'READY', 'FAILED'] } },
                { pdfStatus: 'GENERATING', OR: [{ pdfUpdatedAt: null }, { pdfUpdatedAt: { lt: new Date(now.getTime() - 15 * 60 * 1000) } }] },
                { pdfStatus: 'CLEANING', OR: [{ pdfCleanupLeaseUntil: null }, { pdfCleanupLeaseUntil: { lte: now } }] },
              ],
            },
            data: { pdfStatus: 'CLEANING', pdfCleanupToken: token, pdfCleanupLeaseUntil: leaseUntil, pdfUpdatedAt: now },
          });
          if (receipt.count !== 1) throw new ClaimConflict();
          receiptClaimed = true;
        }

        if (candidate.job?.artifactRef === candidate.artifact.artifactRef) {
          const job = await tx.thermalPdfJob.updateMany({
            where: {
              id: candidate.job.id,
              artifactRef: candidate.artifact.artifactRef,
              OR: [
                { status: { in: ['PENDING', 'READY', 'FAILED'] } },
                { status: 'CLEANING', OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }] },
              ],
            },
            data: { status: 'CLEANING', cleanupToken: token, cleanupLeaseUntil: leaseUntil },
          });
          if (job.count !== 1) throw new ClaimConflict();
          jobClaimed = true;
        }

        return { token, invoiceClaimed, receiptClaimed, jobClaimed };
      });
    } catch (error) {
      if (error instanceof ClaimConflict) return null;
      throw error;
    }
  }

  private async finalize(candidate: Candidate, claim: Claim, now: Date): Promise<number> {
    return prisma.$transaction(async (tx) => {
      let referencesCleared = 0;
      if (claim.invoiceClaimed) {
        const result = await tx.invoice.updateMany({
          where: {
            id: candidate.artifact.sourceId,
            pdfUrl: candidate.artifact.artifactRef,
            pdfStatus: 'CLEANING',
            pdfCleanupToken: claim.token,
          },
          data: {
            pdfUrl: null,
            pdfStatus: 'PENDING',
            pdfError: null,
            pdfAttemptCount: 0,
            pdfUpdatedAt: now,
            pdfCleanupToken: null,
            pdfCleanupLeaseUntil: null,
          },
        });
        if (result.count !== 1) throw new Error('Invoice PDF reference changed before cleanup finalization');
        referencesCleared += result.count;
      }
      if (claim.receiptClaimed) {
        const result = await tx.receipt.updateMany({
          where: {
            id: candidate.artifact.sourceId,
            pdfUrl: candidate.artifact.artifactRef,
            pdfStatus: 'CLEANING',
            pdfCleanupToken: claim.token,
          },
          data: {
            pdfUrl: null,
            pdfStatus: 'PENDING',
            pdfError: null,
            pdfAttemptCount: 0,
            pdfUpdatedAt: now,
            pdfCleanupToken: null,
            pdfCleanupLeaseUntil: null,
          },
        });
        if (result.count !== 1) throw new Error('Receipt PDF reference changed before cleanup finalization');
        referencesCleared += result.count;
      }
      if (claim.jobClaimed) {
        const result = await tx.thermalPdfJob.updateMany({
          where: {
            id: candidate.job?.id,
            artifactRef: candidate.artifact.artifactRef,
            status: 'CLEANING',
            cleanupToken: claim.token,
          },
          data: {
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: now,
            artifactRef: null,
            templateVersion: null,
            lastError: null,
            leaseToken: null,
            leaseUntil: null,
            cleanupToken: null,
            cleanupLeaseUntil: null,
          },
        });
        if (result.count !== 1) throw new Error('Thermal PDF reference changed before cleanup finalization');
        referencesCleared += result.count;
      }

      const removed = await tx.pdfArtifact.deleteMany({
        where: {
          id: candidate.artifact.id,
          artifactRef: candidate.artifact.artifactRef,
          status: 'CLEANING',
          cleanupToken: claim.token,
        },
      });
      if (removed.count !== 1) throw new Error('PDF artifact cleanup lease was lost before finalization');
      return referencesCleared;
    });
  }

  private async deleteWithRetries(artifactRef: string): Promise<{ alreadyMissing: boolean; retries: number }> {
    for (let attempt = 1; attempt <= env.PDF_RETENTION_RETRY_LIMIT; attempt += 1) {
      try {
        await storageService.deletePdf(artifactRef);
        return { alreadyMissing: false, retries: attempt - 1 };
      } catch (error) {
        if (isMissingObject(error)) return { alreadyMissing: true, retries: attempt - 1 };
        if (attempt === env.PDF_RETENTION_RETRY_LIMIT) {
          throw new ArtifactDeleteError(attempt - 1, error);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (2 ** (attempt - 1)), 5000)));
      }
    }
    throw new Error('PDF object deletion retry loop terminated unexpectedly');
  }

  private async forEachConcurrent<T>(
    items: T[],
    concurrency: number,
    action: (item: T) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await action(items[index]);
      }
    });
    await Promise.all(workers);
  }
}

export default new PdfRetentionService();
